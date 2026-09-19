---
'@qtiauth/oidc': minor
'@qtiauth/config': minor
'@qtiauth/events': minor
'@qtiauth/service-kit': minor
'@qtiauth/identity': minor
---

Add the OIDC developer portal: users create, edit and delete public and confidential clients, regenerate secrets with step-up, and staff can verify or suspend a client. Names go through the text filter and cannot contain the product name unless the client is verified. Child accounts cannot register clients. Suspending a client revokes its tokens so the next JWT check and introspection fail.
