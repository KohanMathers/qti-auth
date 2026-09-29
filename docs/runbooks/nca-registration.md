# NCA CSEA-IRP registration

The Online Safety (CSEA Content Reporting by Regulated User-to-User Service Providers) Regulations 2026 (SI 2026/268) require every regulated user-to-user service, whatever its size, to submit CSEA reports to the NCA Industry Reporting Portal (CSEA-IRP). Each deployment operator must register before going live. QTIAuth ships the workflow (see [csea-case-handling.md](csea-case-handling.md)); registration is an operator task.

This runbook is not legal advice. Check the current NCA CSEA-IRP guidance before you register, and involve a legal contact when the questions on the portal need one.

## Prerequisites

- The deployment is or will host at least one user-to-user service (a game with chat, UGC, or player interaction). If it isn't, the duty does not apply and there is nothing to register (see [online-safety-act.md](../online-safety-act.md)).
- You have a decision on who the `safety.accountable_person` will be. The NCA needs a named contact.
- You have a monitored inbox on your own domain for correspondence from the NCA. A shared mailbox is fine, but it must not be a personal one.

## Registration

1. Open the NCA CSEA-IRP registration form at the address in current NCA guidance. Do not follow a link pasted into a chat channel; go via the NCA's own site.
2. Provide the requested company and service details. QTIAuth features that back specific commitments:
   - **Named accountable individual** → `safety.accountable_person.name` and `.role`.
   - **CSEA reporting workflow** → the Safety service's CSEA case handling.
   - **Report retention** → `retention.csea_evidence` (365 d, evidence) and `retention.csea_nca_reference` (1825 d, unique reference).
   - **Access control** → `safety.csea.access` granted by name, never covered by wildcards.
3. Provide the mailbox that will receive the NCA's correspondence. Add a rule that forwards it to the CSEA staff group as well; the mailbox itself must not be a group.
4. Complete the portal's sign-off. When the portal returns a submission URL for your account, save it.

Once the portal replies with your account and a submission URL:

1. Set `safety.csea.nca_portal_url` in `config/qtiauth.yaml` to that submission URL. Staff open it directly from the case page.
2. Restart Safety so the new URL takes effect:
   ```sh
   docker compose --env-file .env -f deploy/compose.yaml restart safety
   ```
3. Confirm the case page shows the new URL and no longer says the portal is unset.
4. Note the registration date in the operator log.

## Keeping registration current

- Update `safety.csea.nca_portal_url` if the NCA gives you a new submission URL. Restart Safety after any change.
- If the accountable person changes, update `safety.accountable_person` and let the NCA know at the correspondence mailbox they gave you.
- Re-read the NCA CSEA-IRP guidance annually and after any published amendment to SI 2026/268. If report fields, timeframes or retention change, reflect them in [compliance/csea.md](../compliance/csea.md) and the relevant config defaults.

## What registration does not cover

- Registration is not authorisation to remove content or accounts outside the CSEA workflow. Moderation actions continue to run through Safety's normal queue.
- Registration does not exempt you from the OSA's other duties. See [online-safety-act.md](../online-safety-act.md) for how QTIAuth's features map to them.
- Registration is not a data-sharing agreement with the NCA. Every submission goes through the portal by hand, with only the fields Schedule 1 requires.
