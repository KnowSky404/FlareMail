# Schema 29 compatibility bridge

Migration 0029 only adds a blocked-sender table, its cleanup trigger, and a nullable quarantine column with an index. The schema 28 Worker requires exact metadata and would stop serving authenticated requests as soon as the migration advances it to 29. This bridge keeps the existing application behavior while recognizing exactly schema 28 and the additive schema 29; older and later versions still fail closed. Telegram continues checking its required tables and columns.

Release the reviewed bridge while production still uses schema 28. Verify its deployment and record its version before applying migration 0029 and deploying the blocked-sender Worker. The bridge is then the code-only rollback target and preserves D1 and R2 data. On rollback the bridge does not apply blocked-sender rules or quarantine filtering: blocked mail can arrive and quarantined mail can appear in the ordinary mailbox until the feature Worker is restored. It does not delete quarantined records or stored mail.

A D1 Time Travel bookmark remains an incident-recovery reference, not an automatic rollback; restoring the database requires separate authorization. Validate the bridge against the exact additive migration and existing mailbox and Telegram paths before release. A healthy endpoint does not prove authenticated functionality or real mail delivery.
