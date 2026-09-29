# Online Safety Act guide for operators

> **Not legal advice.** This guide maps QTIAuth's features to the duties in the UK Online Safety Act 2023 (OSA) and its implementing regulations. Every deployment must run its own risk assessments using Ofcom's Regulation Checker and Child Access Assessment tools, and decide with a legal contact which duties apply. Ofcom's guidance changes; check the current version.

## Which duties apply

The OSA applies to user-to-user services ("U2U") and search services. A user-to-user service is a service where users can generate content that other users can encounter. QTIAuth deployments have two components in scope:

- **The account site, support and knowledge base are not user-to-user services.** Nothing users write reaches other users through them: sign-in, tickets, help articles. The OSA duties do not apply to them.
- **Games with chat, user-generated content or player interaction are user-to-user services.** The duties apply to those games, and QTIAuth provides the machinery through the Safety service (reports, moderation, CSEA workflow) and the Games service (age band, restrictions, parental controls carried in tokens).

If none of the games hosted on the deployment allow users to see each other's content (no chat, no leaderboards where other players can be seen, no UGC), the OSA U2U duties do not apply to the deployment either. Check that assumption against every future game.

**Category 1.** The user identity verification duty for Category 1 services does not apply to any deployment with fewer than 7 million UK users. QTIAuth does not ship a Category 1 identity verification workflow. If a deployment is designated Category 1, that has to be built.

## CSEA reporting

The Online Safety (CSEA Content Reporting by Regulated User-to-User Service Providers) Regulations 2026 (SI 2026/268) have applied to every regulated user-to-user service since 7 April 2026, regardless of size. Every operator hosting a U2U game must:

- Register with the NCA CSEA-IRP portal ([nca-registration.md](runbooks/nca-registration.md)).
- Submit CSEA reports within the priority windows in [compliance/csea.md](compliance/csea.md).
- Retain the report content and the NCA reference for the periods in the same file.

QTIAuth ships the CSEA workflow (report intake, isolated evidence store, guided submission checklist, retention, access control). Staff work through it as in [csea-case-handling.md](runbooks/csea-case-handling.md).

## The duty-by-duty mapping

This table includes the QTIAuth config and features that back each duty and a note on what stays with the operator. "Process" means QTIAuth doesn't automate it; the operator does the work and QTIAuth doesn't get in the way.

| Duty / measure                                          | Applies to                                                | QTIAuth support                                                                                                                                   | Operator does                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Illegal content risk assessment, reviewed annually      | All U2U services                                          | —                                                                                                                                                 | Run the assessment. Keep the record.                                                    |
| Children's access and risk assessment                   | U2U services likely accessed by children                  | Age band data feeds the assessment.                                                                                                               | Run the assessment. Decide what the bands mean for each game.                           |
| **ICU A2** named accountable individual                 | All                                                       | `safety.accountable_person.name` and `.role`.                                                                                                     | Choose the person. Update the config if they change.                                    |
| **ICU C1/C2** moderation function, swift takedown       | All                                                       | Safety moderation queue, config-defined actions with real effects, `remove_content`, game intake API.                                             | Staff the queue. Set the SLA per taxonomy type.                                         |
| **ICU D1/D2** easy reporting and complaints             | All                                                       | User and content reports with snapshots, game intake API, reporter acknowledgement and outcome notifications.                                     | Publish reporting URLs. Set the taxonomy.                                               |
| **ICU D7** act on complaints about illegal content      | All                                                       | Priority-driven queue, SLAs, `qtiauth.safety.report.sla_breached` events.                                                                         | Investigate on time. Feed breaches back into staffing.                                  |
| **ICU D9/D10** appeals                                  | Services that aren't large or multi-risk                  | Appeal ticket per enforcement action, minimal Safety appeal form when Support isn't enabled.                                                      | Answer appeals. Decide when to overturn.                                                |
| **ICU G1/G3** clear, accessible terms                   | All                                                       | Legal document sync at `config/legal/`, acceptance records, material change gate.                                                                 | Write the terms. Publish a version when they change.                                    |
| **ICU H1** remove proscribed organisation accounts      | All                                                       | Safety action `proscribed_org_removal` with the same two-person rule as bans.                                                                     | Have a list. Decide when a report meets it.                                             |
| **ICU F1/F2** child safety defaults                     | High grooming risk, with existing age knowledge           | Not triggered by QTIAuth itself (no social features, §1.2). `age_band`, `restrictions` and `parental_controls` in the token let games apply them. | Decide what defaults each game has for under-18 accounts and enforce them client-side.  |
| **PCU B2–B7** highly effective age assurance            | Only if priority content is permitted or can't be removed | Not triggered by default. A pluggable `AgeAssuranceProvider` interface is ready when it is.                                                       | Decide whether priority content is allowed. If so, wire up a HEAA-certified provider.   |
| **s.66 CSEA reporting to the NCA** (since 7 April 2026) | All U2U services, any size                                | Safety CSEA workflow; see [csea-case-handling.md](runbooks/csea-case-handling.md) and [compliance/csea.md](compliance/csea.md).                   | Register with the NCA. Staff CSEA cases with a trained team.                            |
| Record-keeping of risk assessments and measures         | All                                                       | —                                                                                                                                                 | Keep the records. QTIAuth doesn't have a compliance register yet. |

Related law outside the OSA:

- **ICO Age Appropriate Design Code and UK GDPR**: under-18 defaults (age bands, hidden leaderboards, parental controls), parental consent below `parental.consent_age`, data rights and the deletion ledger, retention sweeps, encrypted backups.

## What to check per deployment

Before turning on any user-to-user game:

- **Confirm the game is U2U-in-scope**, or confirm it's not, and record why.
- **Run Ofcom's Regulation Checker** and record the outcome.
- **Complete a children's access assessment** if there's any prospect of a child accessing the game.
- **Register with the NCA CSEA-IRP** ([nca-registration.md](runbooks/nca-registration.md)) and set `safety.csea.nca_portal_url`.
- **Name the accountable individual** in `safety.accountable_person`.
- **Set the taxonomy** in `safety.taxonomy` with SLAs the moderation team can meet.
- **Publish terms** in `config/legal/` that name illegal content and are enforceable.
- **Decide the child defaults each game applies** using `age_band`, `restrictions` and `parental_controls` claims.
- **Set data retention** for reports (`retention.safety_reports`, 730 d by default), CSEA evidence (`retention.csea_evidence`, 365 d), and the NCA reference (`retention.csea_nca_reference`, 1825 d).

## What QTIAuth doesn't do

- **Automated CSAM classification.** Automated flags come from the operator or a game server, not from QTIAuth. The CSEA workflow starts once a report is classified.
- **Age verification.** The shipped `self_declared` age assurance provider is not "highly effective age assurance" under PCU B2–B7. If a game hosts priority content and can't remove it, wire up a HEAA-certified provider through the `AgeAssuranceProvider` interface.
- **A compliance register.** Recording risk assessments and measures for Ofcom's records is on the operator's side. A register is on the QTIAuth roadmap as `LATER`.
- **Category 1 user identity verification.** Not shipped. If the deployment is designated Category 1, this has to be built.

## When Ofcom asks

Every action a staff member takes shows up in the audit log with `qtiauth audit verify`. Sessions and revocations, moderation actions, CSEA case checklists, legal-document versions and acceptances, and account deletions all flow through it. Ofcom's usual asks (who did what and when, whether reports are being acted on, whether users had accepted the terms in force) come out of that log and the reports queue.

Do not export CSEA case content in response to an Ofcom ask. Ofcom does not receive CSEA reports; the NCA does, through the CSEA-IRP.
