# UK Online Safety Act Compliance Checklist

## ✓ Completed by Default

These are built into the system:

- [x] **Age verification at signup** (date of birth required)
- [x] **Child account flagging** (automatic `is_child` calculation)
- [x] **User reporting system** (content & user reports)
- [x] **Moderation queue** (admin dashboard for report review)
- [x] **Audit trail** (moderation_actions, admin_logs tables)
- [x] **Profanity filtering** (username validation, banned_words table)
- [x] **Rate limiting** (anti-spam, anti-abuse)
- [x] **Secure authentication** (passwordless, JWT sessions)
- [x] **Data retention** (GDPR-compliant user data storage)
- [x] **Terms of Service tracking** (tos_accepted_at field)

---

## ⏳ Required Before Launch

These need human action:

### 1. Legal Documents

- [ ] **Write Terms of Service**
  - Clear rules on prohibited content
  - Enforcement mechanisms
  - Appeal process
  - Link: `/terms`
  
- [ ] **Write Privacy Policy**
  - What data you collect (email, DoB, chat logs, etc.)
  - Why (safety, moderation, compliance)
  - Retention periods
  - User rights (access, delete, etc.)
  - Link: `/privacy`
  
- [ ] **Write Community Guidelines**
  - Expected behavior
  - Prohibited conduct
  - Consequences for violations
  - Link: `/guidelines`

**Deadline**: Before public launch

**Resources**:
- Use plain language (not legalese)
- Template available: https://www.gov.uk/guidance/terms-and-conditions-how-to-write-them
- Consult a lawyer for final review

---

### 2. Risk Assessments

#### Children's Access Assessment (Deadline: 16 April 2025)

Document whether your service is "likely to be accessed by children."

**For QTI Games: YES** (gaming inherently appeals to children)

Write a 1-2 page document stating:
- Service type (multiplayer games with chat)
- Why children are likely to access (gaming, social features)
- Mitigations in place (age verification, content filtering)

**Template**:
```
QTI Games - Children's Access Assessment

1. Service Description
   QTI Games offers multiplayer online games with text and voice chat.

2. Likelihood of Child Access
   HIGH - Gaming platforms are popular with children and teenagers.
   Our marketing does not target children, but we recognize they will access the service.

3. Mitigations
   - Age verification at signup (date of birth required)
   - Child accounts flagged for enhanced protections
   - Content moderation systems
   - User reporting tools

Date: [Today's Date]
Completed by: [Your Name]
```

---

#### Children's Risk Assessment (Deadline: 24 July 2025)

Document risks of harm to children and how you'll mitigate them.

**Template Structure**:

1. **Primary Harmful Content Risks**
   - Bullying/harassment via chat
   - Exposure to hate speech
   - Self-harm content
   - Inappropriate contact from adults
   
2. **Mitigations**
   - Text chat filters (profanity, slurs, threats)
   - User reporting system
   - 24-hour moderation SLA
   - Enhanced privacy for child accounts
   
3. **Secondary Risks**
   - Voice chat moderation challenges
   - Image/video sharing (future feature)
   
4. **Future Mitigations**
   - Voice transcription for reports
   - Automated image moderation (PhotoDNA)
   - Age-gated features

**Save as**: `CHILDRENS_RISK_ASSESSMENT.pdf`

**Resources**:
- Ofcom guidance: https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/how-ofcom-will-protect-users-online

---

#### Illegal Content Risk Assessment (Deadline: 16 March 2025 - OVERDUE IF NOT DONE)

Document risks of illegal content and systems to prevent/remove it.

**Priority Offences for QTI**:
1. Harassment/stalking (via chat)
2. Threatening communications
3. Hate speech (racial/religious hatred)
4. Self-harm/suicide promotion
5. Fraud (account trading, phishing)

**Mitigations**:
- Text chat filters
- User reporting
- Moderation queue
- Ban system
- Audit trail

**Template**:
```
QTI Games - Illegal Content Risk Assessment

1. Service Type: Multiplayer games with user-to-user communication

2. Priority Offences Risk Assessment

   A. Harassment & Threats (HIGH RISK)
      - Likelihood: High (common in online gaming)
      - Impact: Severe (psychological harm, fear)
      - Mitigation: Chat filters, reporting, 24h moderation, bans
      
   B. Hate Speech (MEDIUM-HIGH RISK)
      - Likelihood: Medium (racist/homophobic slurs in gaming)
      - Impact: Severe (targeted harassment)
      - Mitigation: Profanity filters, username validation, reporting
      
   C. Self-Harm Content (MEDIUM RISK)
      - Likelihood: Low-Medium (discussions in chat)
      - Impact: Critical (life-threatening)
      - Mitigation: Keyword filters, urgent priority for reports
      
   D. Fraud (LOW-MEDIUM RISK)
      - Likelihood: Low (account trading, phishing attempts)
      - Impact: Moderate (financial loss)
      - Mitigation: Email verification, reporting system

3. Systems in Place
   - Automated content filtering
   - User reporting mechanism
   - Human moderation within 24 hours
   - Account suspension/banning
   - Audit logs for compliance

4. Review Schedule: Quarterly

Date: [Today's Date]
Completed by: [Your Name]
```

**Save as**: `ILLEGAL_CONTENT_RISK_ASSESSMENT.pdf`

---

### 3. Content Moderation Setup

- [ ] **Expand banned words list**
  - Add gaming-specific slurs
  - Add context-aware patterns
  - Test with your community language
  - Update `schema.sql` banned_words table

- [ ] **Define moderation SLA**
  - Standard: 24 hours (UK OSA expectation)
  - Urgent (CSAM, suicide): Immediate (< 1 hour)
  - Document in moderation policy

- [ ] **Train moderators**
  - How to use moderation queue
  - When to escalate (CSAM → report to IWF)
  - Appeal process
  - Documentation guidelines

- [ ] **Create moderation playbook**
  - Example scenarios
  - Decision trees (warn vs ban)
  - Escalation paths

**Example Moderation Playbook**:
```
Scenario: User posts racist slur in chat

1. Content automatically flagged by filter → pending_reports
2. Moderator reviews within 24h
3. Decision:
   - First offense: Warning + 24h timeout
   - Repeat offense: 7-day suspension
   - Severe/repeated: Permanent ban
4. Log action in moderation_actions table
5. User receives notification with reason
```

---

### 4. Reporting Mechanisms

- [ ] **In-game report button**
  - Add to chat UI
  - Add to user profiles
  - Make prominent and easy to find

- [ ] **Report types clearly labeled**
  - Match UK OSA categories
  - Use plain language
  - Examples provided

- [ ] **Confirmation messages**
  - "Report received, we'll review within 24 hours"
  - Report ID for tracking
  - Link to check status

---

### 5. Transparency & Accountability

- [ ] **Publish transparency report** (annually)
  - Total users
  - Child users (%)
  - Reports received
  - Reports actioned
  - Accounts banned
  - Average review time

- [ ] **Public moderation stats**
  - Update monthly on website
  - Show compliance with SLA
  - Build user trust

- [ ] **User communication**
  - When banned: clear reason, appeal process
  - When warned: what they did wrong, how to avoid future issues
  - Report updates: status changes, outcomes

---

## 📊 Ongoing Compliance

### Daily
- [ ] Check moderation queue (admin dashboard)
- [ ] Review urgent/high priority reports
- [ ] Respond to user appeals

### Weekly
- [ ] Review moderation stats
- [ ] Update banned words list if needed
- [ ] Backup D1 database

### Monthly
- [ ] Audit moderation decisions (quality check)
- [ ] Review child safety measures
- [ ] Update transparency stats

### Quarterly
- [ ] Review risk assessments
- [ ] Update ToS/Privacy Policy if features change
- [ ] Moderator training refresh

### Annually
- [ ] Full compliance audit
- [ ] Publish transparency report
- [ ] Review and update all policies

---

## 🚨 Incident Response

### CSAM (Child Sexual Abuse Material)

If CSAM is detected or reported:

1. **DO NOT VIEW THE CONTENT**
2. Immediately ban the user (moderation queue)
3. Preserve evidence (do not delete immediately)
4. Report to:
   - **UK**: Internet Watch Foundation (IWF) - https://report.iwf.org.uk
   - **US**: National Center for Missing & Exploited Children (NCMEC) - https://www.missingkids.org
5. Document the incident in admin_logs
6. Legal requirement: You MUST report within 24 hours

### Suicide/Self-Harm Content

If user posts suicidal content:

1. Flag as URGENT priority
2. Review immediately (< 1 hour)
3. Consider contacting authorities if imminent threat
4. Remove content quickly
5. Provide crisis resources:
   - **UK**: Samaritans - 116 123
   - **US**: 988 Suicide & Crisis Lifeline

### Terrorism Content

If terrorist content is reported:

1. Do not engage with user
2. Preserve evidence
3. Report to:
   - **UK**: Counter Terrorism Internet Referral Unit - https://www.gov.uk/report-terrorism
4. Remove content immediately
5. Ban user
6. Document thoroughly

---

## 🎯 Ofcom Readiness

If Ofcom contacts you:

### Information They Might Request

- [ ] Risk assessments (children's & illegal content)
- [ ] Moderation policies and SLAs
- [ ] Sample of moderation decisions (anonymized)
- [ ] User reporting data (last 12 months)
- [ ] Terms of Service & Privacy Policy
- [ ] Evidence of compliance systems
- [ ] Staff training records

### Be Ready To Show

1. **Functional reporting system** (demo the in-game report button)
2. **Moderation queue** (show admin dashboard)
3. **Audit trail** (export from moderation_actions table)
4. **Age verification** (explain signup flow)
5. **Child safety measures** (content filters, enhanced protections)

### Export Compliance Data

```bash
# Get all reports from last 12 months
wrangler d1 execute qti_auth --command="
SELECT * FROM user_reports 
WHERE created_at >= unixepoch('now', '-12 months')
" --json > reports_12mo.json

# Get all moderation actions
wrangler d1 execute qti_auth --command="
SELECT * FROM moderation_actions 
WHERE created_at >= unixepoch('now', '-12 months')
" --json > actions_12mo.json

# Get daily stats
wrangler d1 execute qti_auth --command="
SELECT * FROM daily_stats 
WHERE date >= date('now', '-12 months')
" --json > stats_12mo.json
```

---

## 📝 Documentation to Keep

Store these documents securely:

1. **Risk Assessments** (PDF)
   - Children's access assessment
   - Children's risk assessment
   - Illegal content risk assessment

2. **Policies** (Markdown/PDF)
   - Terms of Service
   - Privacy Policy
   - Community Guidelines
   - Moderation Policy

3. **Training Materials** (PDF/Video)
   - Moderator onboarding
   - Escalation procedures
   - Incident response playbook

4. **Compliance Reports** (JSON/CSV)
   - Weekly report exports
   - Monthly transparency stats
   - Annual transparency report

5. **Audit Logs** (SQL exports)
   - Moderation actions
   - Admin logs
   - High-risk incidents

---

## 🔍 Self-Assessment Questions

Ask yourself quarterly:

1. **Age Verification**
   - ✓ Is every new user providing date of birth?
   - ✓ Are child accounts flagged correctly?
   - ✓ Are child safety measures working?

2. **Content Moderation**
   - ✓ Are reports reviewed within 24 hours?
   - ✓ Are urgent reports handled immediately?
   - ✓ Is the banned words list up to date?

3. **User Safety**
   - ✓ Can users easily report harmful content?
   - ✓ Do users receive report status updates?
   - ✓ Is the appeal process clear and fair?

4. **Transparency**
   - ✓ Are moderation stats publicly available?
   - ✓ Are policies easy to find and understand?
   - ✓ Do users know what's prohibited?

5. **Risk Management**
   - ✓ Have risk assessments been updated this year?
   - ✓ Have there been new features requiring reassessment?
   - ✓ Are staff trained on latest policies?

---

## ✅ Ready for Launch Checklist

Before going live:

- [ ] All risk assessments completed and saved
- [ ] ToS, Privacy Policy, Community Guidelines written
- [ ] First admin account created
- [ ] Moderation queue tested
- [ ] User reporting flow tested end-to-end
- [ ] Email magic links working
- [ ] Age verification enforced
- [ ] Banned words list expanded
- [ ] Moderators trained
- [ ] Incident response procedures documented
- [ ] Ofcom information pack prepared
- [ ] Weekly backup cron job scheduled
- [ ] Monitoring dashboards configured

**When all boxes checked: You're compliant. Ship it.** 🚀

---

## Resources

- **Ofcom Online Safety**: https://www.ofcom.org.uk/online-safety
- **UK OSA Full Text**: https://www.legislation.gov.uk/ukpga/2023/50
- **IWF Reporting**: https://report.iwf.org.uk
- **Age Verification Providers**: Yoti, Jumio, Onfido
- **Content Moderation**: Hive, Spectrum Labs, Two Hat

---

**Last Updated**: [Date]
**Next Review**: [Date + 3 months]
