# Client Answers

Track answers to the questions sent to the client. **Never write secret values here** (passwords, keys, tokens) — those go only into the password manager / server env.

| # | Question | Status | Answer | Date |
| --- | --- | --- | --- | --- |
| 1 | SIP details: host/IP, port, transport (UDP/TCP/TLS), auth (username/password or IP whitelist of our server) | pending | | |
| 2 | Phone numbers: outbound caller ID (DID) and inbound number | pending | | |
| 3 | Audio & limits: codecs (G.711 PCMU/PCMA), RTP port range, max concurrent calls | pending | | |
| 4 | Server: is a SIP server (Asterisk/FreeSWITCH) already running? Which apps/ports are already in use? | pending | | |
| 5 | Database: type (MongoDB/MySQL/…), host, port, username, database name; separate DB for our app allowed? | pending | | |
| 6 | Domain / subdomain for our app (HTTPS + webhooks) | pending | | |

## Already received (non-secret facts)

| Item | Value | Date |
| --- | --- | --- |
| Server | AWS EC2, instance type m6a.2xlarge (8 vCPU), 108 GB storage, user `ubuntu`, key-file auth | 2026-10-06 |
| Server condition | Deploy our app separately; do not disturb the other application on the server | 2026-10-06 |
| Telephony | Client says SIP is enabled (details pending) | 2026-10-06 |
| Credentials | SSH key file and DB password shared over WhatsApp → stored only in password manager; treat as exposed, rotate before production | 2026-10-06 |
