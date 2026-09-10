CREATE VIEW `runs_with_hints` AS 
  SELECT
    r.*,
    (SELECT s.model FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL LIMIT 1) AS model,
    (SELECT CASE WHEN COUNT(*) > 0
                  AND COUNT(*) = COUNT(CASE WHEN s.status IN ('OK','ERROR') THEN 1 END)
                 THEN 1 ELSE 0 END
     FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL) AS finished,
    (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
    (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count,
    (SELECT COALESCE(SUM(LENGTH(COALESCE(s.input_payload, '')) + LENGTH(COALESCE(s.output_payload, ''))), 0)
     FROM spans s WHERE s.run_id = r.id) AS payload_total_chars
  FROM runs r
;