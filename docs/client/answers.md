# Client Answers

Track answers to the questions sent to the client. **Never write secret values here** (passwords, keys, tokens) — those go only into the password manager / server env.

| #   | Question                                                                                                    | Status                                                                                               | Answer | Date |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | SIP details: host/IP, port, transport (UDP/TCP/TLS), auth (username/password or IP whitelist of our server) | pending                                                                                              |        |      |
| 2   | Phone numbers: outbound caller ID (DID) and inbound number                                                  | pending                                                                                              |        |      |
| 3   | Audio & limits: codecs (G.711 PCMU/PCMA), RTP port range, max concurrent calls                              | pending                                                                                              |        |      |
| 4   | Server: is a SIP server (Asterisk/FreeSWITCH) already running? Which apps/ports are already in use?         | pending — read-only audit ready but blocked (no SSH key yet), see [server-audit.md](server-audit.md) |        |      |
| 5   | Database: type (MongoDB/MySQL/…), host, port, username, database name; separate DB for our app allowed?     | pending                                                                                              |        |      |
| 6   | Domain / subdomain for our app (HTTPS + webhooks)                                                           | pending                                                                                              |        |      |

## Already received (non-secret facts)

| Item             | Value                                                                                                                           | Date       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Server           | AWS EC2, instance type m6a.2xlarge (8 vCPU), 108 GB storage, user `ubuntu`, key-file auth                                       | 2026-10-06 |
| Server condition | Deploy our app separately; do not disturb the other application on the server                                                   | 2026-10-06 |
| Telephony        | Client says SIP is enabled (details pending)                                                                                    | 2026-10-06 |
| Credentials      | SSH key file and DB password shared over WhatsApp → stored only in password manager; treat as exposed, rotate before production | 2026-10-06 |

## Compliance questions (for the client's legal / compliance team)

Full list and context: [compliance-notes.md §7](../compliance/compliance-notes.md#7-questions-for-the-clients-legal--compliance-team).

| #   | Question                                                                      | Status  | Answer | Date |
| --- | ----------------------------------------------------------------------------- | ------- | ------ | ---- |
| C1  | Lender licence type and which RBI recovery directions apply                   | pending |        |      |
| C2  | Calls from a 1600-series number? Who handles DLT / number registration?       | pending |        |      |
| C3  | Calling window for recovery calls (default 09:00–19:00)                       | pending |        |      |
| C4  | Max call attempts per borrower per day / week                                 | pending |        |      |
| C5  | Record every call? Intimation wording? Retention period                       | pending |        |      |
| C6  | AI disclosure — yes/no and exact wording                                      | pending |        |      |
| C7  | DPDP lawful basis; OK to process voice with OpenAI (US)? Localisation limits? | pending |        |      |
| C8  | Identity verification before discussing dues                                  | pending |        |      |
| C9  | When must a human agent take over?                                            | pending |        |      |
| C10 | DPA signatory and breach-notification timeline                                | pending |        |      |
