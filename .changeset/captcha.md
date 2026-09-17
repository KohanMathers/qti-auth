---
'@qtiauth/identity': minor
'@qtiauth/config': minor
'@qtiauth/captcha': minor
'@qtiauth/observability': patch
---

Add adaptive CAPTCHA to identity: Altcha by default, with Turnstile, hCaptcha, Friendly Captcha and none. Shown after a configurable number of password failures or signup/magic-link starts from an IP, then required until solved.
