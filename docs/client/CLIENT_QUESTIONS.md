# AI Voicebot Project — Questions

To design and build the voicebot correctly, we need a few details. Please answer each question below. Where you have existing documents, such as API docs, a sample script or a sample contact sheet, sharing them is enough.

---

## A. NotifyNow Voice API (technical)

1. **Personalised messages:** Can one campaign send a different message to each contact (e.g. "Dear {{name}}, your ₹{{amount}} loan is {{days}} days overdue")? Or do we need to place a separate call per contact?
2. **Multi-step IVR:** After the customer presses a key, can we play another message and branch further (press 1 → message A, press 2 → message B → another key press)? Or is only one key press captured per call?
3. **Live audio streaming:** Does NotifyNow support real-time two-way audio streaming (WebSocket, SIP or media streams)? We need this so an AI agent can hold a live conversation with the customer.
4. **Inbound calls:** Are inbound calls supported? Can we get a number that customers call, and can those calls be routed to our webhook or audio stream?
5. **Call recording:** Are calls recorded? Is a recording URL returned, and how long is it kept?
6. **Call transfer:** Can a live call be transferred to a human agent's number?
7. **Call control:** Can we end or change an in-progress call through the API?
8. **Languages and voices:** Which languages and TTS voices are supported (Hindi, English, Hinglish, regional)? Can we pick the voice (male/female) or use a custom voice?
9. **Caller ID:** Which number does the customer see? Can the client use their own number, and does it need DLT or other registration?
10. **Pricing:** What is the rate per minute or per pulse (15s/30s/60s)? Are unanswered, busy or failed calls charged? Are test calls charged?
11. **Limits:** What are the concurrent call limit, the API rate limit and the maximum number of contacts per campaign?
12. **Webhooks:** Please share the full webhook payload format: all status values, DTMF digit, duration, recording URL and per-call ID. Are webhooks signed or authenticated? Are failed webhook deliveries retried?
13. **Call-status URL:** What is `https://notifynow.in/api/webhooks/voice/call-status` for? Do we register our own URL there, or is it an example?
14. **Campaign APIs:** Is there an API to fetch campaign and per-call status, and to pause or cancel a running campaign? Does `send-campaign` return a campaign ID and call IDs?
15. **Retries:** How exactly do `retries` and `retry_interval` work? What unit is `retry_interval`, and which call outcomes trigger a retry?
16. **Audio files:** Which audio formats are supported, and what are the size and duration limits?
17. **Compliance handled by NotifyNow:** Do you scrub DND numbers or enforce calling hours on your side?
18. **Docs and environment:** Is there full API documentation and a sandbox? Is the shared API key a test key or a live key?

## B. Use case and business

19. **Script and flow:** What exactly should the loan recovery call say and do? Please share a sample script and the flow (what happens on each key press or answer).
20. **Languages:** Which languages do your customers need (Hindi, English, regional)?
21. **Volume:** How many calls per day do you expect, and how many at the same time at peak?
22. **Payment check API:** Do you have an API we can call to check whether a customer has paid? Please share its docs and authentication details.
23. **Contact data:** Please share a sample contact sheet with all columns and variables you will upload (name, phone, amount, due days, etc.).
24. **Calling hours and compliance:** What calling hours should we use (RBI recovery guidelines suggest 8am–7pm)? Do you have customer consent for automated/AI calls? Should each call announce that it is automated and recorded?
25. **Human agent:** Should the bot transfer to a human agent when needed? If yes, to which number(s)?
26. **Recordings:** How long should call recordings and transcripts be kept?
27. **Reports:** Which outcomes do you want tracked (paid, promise to pay, wrong number, callback, not reachable, etc.)? In what format do you want reports?
28. **Inbound use case:** When customers call in, which number will they dial and what should the bot help with?
29. **Follow-up:** Should an SMS or WhatsApp message be sent after the call (e.g. a payment link)?
30. **Billing:** Is a prepaid wallet model OK for you? What per-minute rate or budget do you have in mind?
31. **Timeline:** When do you want the first pilot to go live?

---

Thank you. Once we have these answers, we will share the detailed phase-wise plan and timeline.
