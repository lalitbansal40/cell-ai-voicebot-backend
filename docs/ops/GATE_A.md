# Gate A — owner inputs before Batch 2

1. **Server** (plan §7 #1): an Ubuntu 24.04 LTS x86_64 server, ≥ 4 vCPU / 8 GB / 80 GB SSD, with a **static public IPv4** (Elastic IP), in `ap-south-1` (or tell us another region). Not the client's existing EC2.
2. **Security group / firewall:** inbound TCP 22 from your office / home IPs only, TCP 80 + 443 from anywhere, **UDP 40000–40999 from anywhere**; outbound all.
3. **SSH access:** an admin user with `sudo` (e.g. `ubuntu`) and the private key saved at `~/.ssh/cav-staging.pem` (`chmod 400`); tell the run the host IP and the user name (not secret).
4. **Domain** (plan §7 #2): the app hostname (e.g. `app.<client-domain>`) with an **A record → the Elastic IP** (TTL 300), plus a CAA record allowing `letsencrypt.org` if the domain uses CAA.
5. **E-mail** (plan §7 #6): SMTP host / port / user / password for the sender domain + **SPF, DKIM, DMARC DNS records** added as the SMTP provider says; the sender address (e.g. `no-reply@<domain>`).
6. **OpenAI:** a separate project API key for staging with a monthly budget cap (plan §7 #5).
7. **Razorpay test mode:** `rzp_test_…` key id + secret + a webhook secret (you will paste the webhook URL in Razorpay after the first deploy — the run prints it).
8. **Billing seller details** for invoices (plan §7 #10): legal name, address, GSTIN, state code.
9. **Backup target** (plan §7 #8): an S3 bucket (versioning on, lifecycle 30 days) + an access key limited to that bucket (put / get / list / delete), or another off-server target; and an `age` public key whose private key only you keep (`age-keygen` — the run can generate the pair on your Mac into `~/.cav-staging/backup.key` if you prefer; the private key never leaves your Mac / password manager).
10. **Alerts** (plan §7 #9): the e-mail address(es) for alerts; create an UptimeRobot (or similar) account — the run gives the two monitor URLs.
11. **Secrets file:** put items 5–9 into `~/.cav-staging/backend.env` on this Mac (`chmod 600`) using `deploy/staging/env.example` as the template (the run created it) — **never paste secrets into the chat**. Fill the non-secret lines too (`APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `WA_MEDIA_PUBLIC_IP`, `MAIL_FROM`, `BILLING_SELLER_*`). Leave the `META_*` lines empty (GATE B).
12. **Demo users:** choose the review demo owner e-mail (a mailbox you can read) and put `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD` (≥ 16 chars), `DEMO_TEST_PHONES` (your test phones, E.164) in `~/.cav-staging/demo.env` (600); a superadmin e-mail + password in `~/.cav-staging/superadmin.env` (600).
13. **Business verification** (plan §7 #3) — **start today** (takes 2–5 business days): business.facebook.com → the owning business → Security Center → Start verification (legal name, address, phone, website on the app domain, documents). Report when it is "Verified" (needed at GATE B / C).
14. **Legal:** send the privacy / terms drafts (`/privacy`, `/terms` on the rehearsal build, or the Markdown files) to the client's legal team for approval; get the grievance officer name + contact (plan §7 #11).
