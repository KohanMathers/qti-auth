# CSEA / NCA reporting (SI 2026/268)

This records the legal parameters used by the CSEA workflow in Safety. It is not legal advice. Confirm the current NCA CSEA-IRP guidance before going live.

The Online Safety (CSEA Content Reporting by Regulated User-to-User Service Providers) Regulations 2026 (SI 2026/268) have applied to every regulated user-to-user service since 7 April 2026, regardless of size. The values below are the statutory fields, timeframes and retention periods that config defaults implement.

## Operator registration

Each deployment operator must register with the NCA Industry Reporting Portal (CSEA-IRP) before live reporting. After registration, set `safety.csea.nca_portal_url` to the portal URL staff should open. Until then the field stays empty and is shown as unset on the case page. Staff still submit through the portal by hand and record the unique reference here; there is no NCA API plugin yet.

Grant `safety.csea.access` by name. `*` and `safety.*` never cover it. Built-in roles do not include it.

Set `safety.csea.encryption_key` (the stack reuses `APP_ENCRYPTION_KEY` by default). Safety will not start with CSEA enabled if the key is missing or not 32 bytes. Set `safety.csea_alert_emails` to the staff who should get the alert-only mail that a case exists.

## Report fields (Schedule 1)

The case checklist is the Schedule 1 information, grouped so staff can mark each field available and fill a value:

| Checklist field                                                                                                                    | Schedule 1                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `reporting_person_name`, `reporting_person_email`, `reporting_person_telephone`                                                    | The person making the report                                                                   |
| `detected_content`, `detection_method`                                                                                             | The CSEA content and how it was detected                                                       |
| `platform`                                                                                                                         | The service or game                                                                            |
| `previous_report`, `previous_nca_reference`                                                                                        | Whether this content or account was reported before                                            |
| `uploaded_at`, `upload_ip`, `upload_ip_at`, `exif`                                                                                 | Upload time, IP and embedded metadata when held                                                |
| `content_url`, `original_hash`                                                                                                     | Location and hash of the original file when held                                               |
| `account_username`, `billing_details`, `email`, `recovery_email`, `telephone`, `telephone_verified_at`, `profile_url`, `login_ips` | Account identifiers                                                                            |
| `declaration`                                                                                                                      | The reporting person's declaration that the information is true to the best of their knowledge |

Detection method, platform (when the report has a `game_id`), upload time and whether content is held are prefilled from the report. Everything else is filled by staff from what the operator can lawfully obtain. Recording a submission requires `declaration: true`.

## Timeframes

SI 2026/268 requires priority 1 reports immediately, priority 2 as soon as reasonably practicable, and priority 3 without undue delay. Config turns those into operational deadlines on the case:

| Priority | Legal requirement                                      | Default window | Config                   |
| -------- | ------------------------------------------------------ | -------------- | ------------------------ |
| 1        | Immediately (threat to a child's life or serious harm) | 15 minutes     | `safety.csea.priority_1` |
| 2        | As soon as reasonably practicable                      | 4 hours        | `safety.csea.priority_2` |
| 3        | Without undue delay                                    | 24 hours       | `safety.csea.priority_3` |

New cases default to priority 2. Staff can record a different priority when they submit. The queue lists open and submitted cases by submission deadline.

## Retention

| What                                                    | SI 2026/268                                               | Default         | Config                         |
| ------------------------------------------------------- | --------------------------------------------------------- | --------------- | ------------------------------ |
| Copy of the CSEA content and other reported information | regulation 8(1)(b): one year after the NCA report is sent | 365d            | `retention.csea_evidence`      |
| Unique NCA report reference                             | regulation 8(1)(a): five years after submission           | 1825d (365 × 5) | `retention.csea_nca_reference` |

`safety.csea_retention` (daily 03:15) and `retention.sweep` destroy due evidence, replace the sealed blob with an empty marker, and write an audit record `csea.evidence.destroyed`. The NCA reference is cleared once `csea_nca_reference` has elapsed. Open cases and unswept evidence are not deleted with the reported account.

## Isolation

Case content is never written to logs, traces, metric labels, webhooks or email bodies. The only notification is `csea_case_opened` to `csea_alert_emails`, with a link. `safety.csea.case_opened` and `safety.csea.enforced` are not webhook-deliverable, even to `*`. Legal-hold copies live under `legal-hold/` and survive erasure while the hold is in place.
