// Mistral Vibe agent collector
// Collects token usage from Mistral Vibe local session files (~/.vibe/logs/session/*.jsonl)
//
// Format notes (to be verified - see requests/mistral.md):
// - Files are JSON Lines with one event per line
// - Message events have type: "message" and token_usage object
// - token_usage contains cumulative input_tokens and output_tokens
// - session_id and turn_id are present in message events
// - Example line: {"type":"message","session_id":"s-abc","turn_id":"t-123","token_usage":{"input_tokens":100,"output_tokens":50},"model":"mistral-medium-latest","timestamp":"2024-01-01T00:00:00Z"}
//
// Only numeric data leaves the machine: token counts, timestamps, model names.
// Never reads, sends, or logs: prompts, answers, tool output, file contents, file paths.

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { configFile, home, lock, post, readJson, writeJson } from '../lib/core.mjs'
import { BATCH } from '../lib/contract.mjs'

const vibeHome = process.env.VIBE_HOME || join(homedir(), '.vibe')
const sessionDir = join(vibeHome, 'logs', 'session')
const stateFile = join(home, 'mistral-state.json')

// Maximum number of sent turns to keep in state (prevent unbounded growth)
const MAX_SENT_ENTRIES = 10000

// Ensure state directory exists
function ensureStateDir() {
  try {
    const stateDir = join(home, '.token-tracker')
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    }
  } catch { /* ignore */ }
}

/**
 * Get all session files from Mistral Vibe
 */
function getSessionFiles() {
  if (!existsSync(sessionDir)) return []
  
  try {
    return readdirSync(sessionDir)
      .filter(f => f.startsWith('session-') && f.endsWith('.jsonl'))
      .map(f => join(sessionDir, f))
  } catch {
    return []
  }
}

/**
 * Parse a Mistral Vibe session file (JSON Lines format)
 * Extracts TurnRow data from message events with token_usage
 * Uses cumulative token counts to calculate deltas between events
 * Uses line number as part of turn_id to ensure uniqueness within a session
 */
function parseSessionFile(path) {
  const turns = []
  let lastInputTotal = 0
  let lastOutputTotal = 0
  
  try {
    const content = readFileSync(path, 'utf8')
    const lines = content.trim().split('\n')
    
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]
      if (!line.trim()) continue
      
      try {
        const event = JSON.parse(line)
        
        // Only process message events with token_usage
        if (event.type === 'message' && event.token_usage) {
          const tokenUsage = event.token_usage
          const inputTotal = Number(tokenUsage.input_tokens) || 0
          const outputTotal = Number(tokenUsage.output_tokens) || 0
          
          // Calculate delta (Mistral Vibe provides cumulative tokens per session)
          const inputDelta = Math.max(0, inputTotal - lastInputTotal)
          const outputDelta = Math.max(0, outputTotal - lastOutputTotal)
          
          // Only add if there's actual token usage
          if (inputDelta > 0 || outputDelta > 0) {
            // Generate stable, unique turn_id using line number to avoid collisions
            // Format: mistral:<session_id>:<turn_id_or_index>:<line_number>
            const sessionId = event.session_id || basename(path).replace('.jsonl', '')
            const turnId = event.turn_id || String(lineIndex)
            const stableTurnId = `mistral:${sessionId}:${turnId}:${lineIndex}`
            
            turns.push({
              provider: 'mistral',
              turn_id: stableTurnId,
              session_id: sessionId,
              ts: event.timestamp || new Date().toISOString(),
              model: event.model || 'unknown',
              input_tokens: inputDelta,
              output_tokens: outputDelta,
              cache_read_tokens: 0, // Mistral Vibe doesn't expose cache tokens yet
              cache_creation_tokens: 0,
              duration_ms: event.duration_ms || 0,
              is_subagent: event.is_subagent === true || false
            })
          }
          
          // Update totals for next delta calculation
          lastInputTotal = inputTotal
          lastOutputTotal = outputTotal
        }
      } catch (e) {
        // Skip malformed lines without exposing file content
        console.warn(`Failed to parse session line ${lineIndex + 1}: ${e.message}`)
      }
    }
  } catch (e) {
    console.warn(`Failed to read session file: ${e.message}`)
  }
  
  return turns
}

/**
 * Get the signature for a turn (used for deduplication)
 */
function getTurnSignature(turn) {
  return `${turn.input_tokens},${turn.output_tokens},${turn.cache_read_tokens},${turn.cache_creation_tokens}`
}

/**
 * Clean up old entries from state.sent to prevent unbounded growth
 */
function cleanupStateSent(state) {
  const entries = Object.entries(state.sent || {})
  if (entries.length <= MAX_SENT_ENTRIES) return
  
  // Keep the most recent half of entries
  const entriesToKeep = entries.slice(-Math.floor(MAX_SENT_ENTRIES / 2))
  state.sent = Object.fromEntries(entriesToKeep)
}

/**
 * Synchronize session files with the server
 * Uses since, lock, and post from core.mjs
 * Only sends turns that are new or have grown since last sync
 */
async function syncSessions({ full = false, onFile, only, since } = {}) {
  const cfg = readJson(configFile, null)
  if (!cfg?.token) {
    throw new Error('Device not linked. Run: token-tracker link <CODE>')
  }
  
  ensureStateDir()
  const state = readJson(stateFile, { files: {}, sent: {}, lastSync: null, lastError: null, enabled: true })
  
  // Check if agent is enabled
  if (!state.enabled) {
    return { files: 0, scanned: 0, rows: 0, limits: false, disabled: true }
  }
  
  const unlock = lock('mistral')
  if (!unlock) {
    return { files: 0, scanned: 0, rows: 0, limits: false, busy: true }
  }
  
  const stats = { files: 0, scanned: 0, rows: 0, limits: false }
  
  try {
    const paths = only 
      ? [only].filter(f => existsSync(f) && f.endsWith('.jsonl'))
      : getSessionFiles()
    
    for (const [n, path] of paths.entries()) {
      onFile?.(n + 1, paths.length)
      stats.files++
      
      const st = statSync(path)
      const fileSig = `${st.size}:${Math.floor(st.mtimeMs)}`
      
      // Skip if not modified and not full sync
      if (!full && state.files[path] === fileSig) continue
      
      // Skip if file is older than 'since' timestamp
      if (since) {
        const sinceDate = new Date(since)
        const fileDate = new Date(st.mtimeMs)
        if (fileDate < sinceDate) continue
      }
      
      stats.scanned++
      const turns = parseSessionFile(path)
      
      // Filter turns: only new or modified since last sync
      const fresh = turns.filter(t => {
        const sig = getTurnSignature(t)
        const existingSig = state.sent[t.turn_id]
        
        // If full sync, send everything
        if (full) return true
        
        // If turn not sent before, send it
        if (!existingSig) return true
        
        // If turn was sent but has grown, send updated version
        const [existingInput, existingOutput] = existingSig.split(',').map(Number)
        return t.input_tokens > existingInput || t.output_tokens > existingOutput
      })
      
      // Send in batches
      for (let i = 0; i < fresh.length; i += BATCH) {
        const batch = fresh.slice(i, i + BATCH)
        try {
          await post(cfg, { rows: batch })
        } catch (err) {
          state.lastError = `Failed to send batch: ${err.message}`
          unlock?.()
          throw err
        }
      }
      
      // Update state for successfully sent turns
      for (const t of fresh) {
        state.sent[t.turn_id] = getTurnSignature(t)
      }
      
      state.files[path] = fileSig
      stats.rows += fresh.length
    }
    
    // Clean up old sent entries
    cleanupStateSent(state)
    
    state.lastSync = new Date().toISOString()
    delete state.lastError
    writeJson(stateFile, state)
    
  } catch (err) {
    state.lastError = err.message
    writeJson(stateFile, state)
    throw err
  } finally {
    unlock?.()
  }
  
  return stats
}

/**
 * Enable the Mistral Vibe collector
 */
function enable() {
  ensureStateDir()
  const state = readJson(stateFile, { enabled: true })
  state.enabled = true
  writeJson(stateFile, state)
}

/**
 * Disable the Mistral Vibe collector
 */
function disable() {
  ensureStateDir()
  const state = readJson(stateFile, { enabled: true })
  state.enabled = false
  writeJson(stateFile, state)
}

/**
 * Get hook state for Mistral Vibe collector
 */
function hookState() {
  ensureStateDir()
  const state = readJson(stateFile, { enabled: true, lastSync: null, lastError: null })
  return {
    enabled: state.enabled !== false,
    lastSync: state.lastSync,
    lastError: state.lastError
  }
}

/**
 * Get status information for Mistral Vibe collector
 */
function getStatus() {
  ensureStateDir()
  const state = readJson(stateFile, { files: {}, sent: {}, lastSync: null, lastError: null, enabled: true })
  
  return {
    lastSync: state.lastSync,
    lastError: state.lastError,
    enabled: state.enabled !== false,
    files: Object.keys(state.files || {}).length,
    sentTurns: Object.keys(state.sent || {}).length
  }
}

export default {
  id: 'mistral',
  title: 'Mistral Vibe',
  home: vibeHome,
  
  // Check if Mistral Vibe is installed
  detect: () => existsSync(vibeHome),
  
  // Main sync function
  sync: syncSessions,
  
  // Status information
  status: getStatus,
  
  // Enable/disable hooks
  enable,
  disable,
  hookState
}
