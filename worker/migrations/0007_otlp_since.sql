-- When a device's tokens started to be counted from OpenTelemetry (its first OTLP call). Before that moment the numbers come from elsewhere
-- (an imported history, an older collector) and may be incomplete; the charts draw a line there. NULL = never sent through OTLP.
ALTER TABLE devices ADD COLUMN otlp_since TEXT;
UPDATE devices SET otlp_since = (SELECT MIN(ts) FROM token_events WHERE device_id = devices.id AND turn_id LIKE 'otlp:%');
