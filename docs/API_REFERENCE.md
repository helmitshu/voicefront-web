# VoiceFront API Reference

**Base URL:** `https://voicefrontapi-production.up.railway.app` (prod), `http://localhost:4000` (local)

All requests should include `Content-Type: application/json` (except file uploads, which use `multipart/form-data`).

---

## Authentication

All protected endpoints require a JWT bearer token in the `Authorization` header:

```
Authorization: Bearer <jwt-token>
```

Tokens are obtained from `/api/auth/login` or `/api/auth/register` and expire after 7 days.

---

## Error Format

All errors follow this envelope:

```json
{
  "error": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "details": {}
  }
}
```

Common HTTP status codes:
- **200/201:** Success
- **400:** Validation error (bad input)
- **401:** Unauthorized (missing or invalid JWT)
- **403:** Forbidden (user doesn't have permission)
- **404:** Not found
- **409:** Conflict (e.g., duplicate email, slot already booked)
- **503:** Service unavailable (e.g., Vapi is down)

---

## Auth Endpoints

### POST /api/auth/register

Create a new tenant and owner account.

**Request:**
```json
{
  "email": "alice@acme.com",
  "password": "secure-password-123",
  "fullName": "Alice Acme",
  "companyName": "ACME Corp",
  "industry": "CLINIC"
}
```

**Response (201):**
```json
{
  "token": "eyJhbGc...",
  "user": {
    "id": "user-123",
    "email": "alice@acme.com",
    "fullName": "Alice Acme",
    "role": "OWNER",
    "tenantId": "tenant-123"
  },
  "tenant": {
    "id": "tenant-123",
    "slug": "acme-corp",
    "companyName": "ACME Corp",
    "industry": "CLINIC",
    "subscriptionStatus": "TRIALING"
  }
}
```

**Errors:**
- 400: Email already exists, password too short, missing fields
- 429: Too many registration attempts (rate limit)

---

### POST /api/auth/login

Authenticate a user and receive a JWT token.

**Request:**
```json
{
  "email": "alice@acme.com",
  "password": "secure-password-123"
}
```

**Response (200):**
```json
{
  "token": "eyJhbGc...",
  "user": {
    "id": "user-123",
    "email": "alice@acme.com",
    "fullName": "Alice Acme",
    "role": "OWNER",
    "tenantId": "tenant-123"
  },
  "tenant": {
    "id": "tenant-123",
    "slug": "acme-corp",
    "companyName": "ACME Corp",
    "industry": "CLINIC",
    "subscriptionStatus": "ACTIVE"
  }
}
```

**Errors:**
- 400: Invalid credentials
- 429: Too many login attempts (rate limit)

---

### GET /api/auth/me

Get the current user's session (user + tenant + onboarding status).

**Response (200):**
```json
{
  "user": {
    "id": "user-123",
    "email": "alice@acme.com",
    "fullName": "Alice Acme",
    "role": "OWNER",
    "tenantId": "tenant-123"
  },
  "tenant": {
    "id": "tenant-123",
    "slug": "acme-corp",
    "companyName": "ACME Corp",
    "industry": "CLINIC",
    "subscriptionStatus": "ACTIVE"
  },
  "onboarding": {
    "hasConfiguredProfile": true,
    "hasConfiguredPrompt": true,
    "hasTestedVoice": true,
    "isActive": true
  }
}
```

**Errors:**
- 401: Invalid token

---

## Onboarding Endpoints

### GET /api/onboarding/status

Get the current onboarding step.

**Response (200):**
```json
{
  "hasConfiguredProfile": false,
  "hasConfiguredPrompt": false,
  "hasTestedVoice": false,
  "isActive": false,
  "currentStep": "PROFILE"
}
```

---

### POST /api/onboarding/complete-step

Complete an onboarding step.

**Request:**
```json
{
  "step": "PROFILE",
  "data": {
    "companyName": "ACME Corp",
    "industry": "CLINIC",
    "timezone": "America/Los_Angeles",
    "businessHours": {
      "mon": { "enabled": true, "open": "09:00", "close": "17:00" },
      "tue": { "enabled": true, "open": "09:00", "close": "17:00" },
      "wed": { "enabled": true, "open": "09:00", "close": "17:00" },
      "thu": { "enabled": true, "open": "09:00", "close": "17:00" },
      "fri": { "enabled": true, "open": "09:00", "close": "17:00" },
      "sat": { "enabled": false, "open": "10:00", "close": "14:00" },
      "sun": { "enabled": false, "open": "10:00", "close": "14:00" }
    }
  }
}
```

**Response (200):**
```json
{
  "hasConfiguredProfile": true,
  "hasConfiguredPrompt": false,
  "hasTestedVoice": false,
  "isActive": false,
  "currentStep": "PROMPT"
}
```

**Steps in order:** `PROFILE` → `PROMPT` → `VOICE_TEST`

**Errors:**
- 400: Missing required fields, invalid timezone
- 409: Step already completed (must start fresh)

---

### POST /api/onboarding/activate

Activate the tenant (go live). Requires all onboarding steps complete.

**Response (200):**
```json
{
  "isActive": true,
  "message": "Tenant is now live and ready to receive calls."
}
```

**Errors:**
- 409: Not all onboarding steps are complete

---

## Agent Settings Endpoints

### GET /api/agent/settings

Get the tenant's receptionist settings.

**Response (200):**
```json
{
  "displayName": "Maya",
  "systemPrompt": "You are a friendly receptionist for ACME Corp...",
  "firstMessage": "Hi! This is Maya with ACME Corp. How can I help you?",
  "voicemailGreeting": "Thanks for calling ACME. Please leave a message.",
  "businessHours": {
    "mon": { "enabled": true, "open": "09:00", "close": "17:00" },
    ...
  },
  "timezone": "America/Los_Angeles",
  "voiceProvider": "vapi",
  "voiceId": "Emma",
  "forwardingNumbers": [
    { "number": "+15551234567", "label": "Owner" },
    { "number": "+15559999999", "label": "Support" }
  ],
  "inboundPhoneNumber": "+15556789999",
  "backgroundSound": "office",
  "monthlyMinuteLimit": 500,
  "monthlyMinutesUsed": 142
}
```

---

### PATCH /api/agent/settings

Update agent settings.

**Request (partial update allowed):**
```json
{
  "displayName": "Maya",
  "systemPrompt": "You are a friendly receptionist...",
  "voiceId": "Savannah",
  "businessHours": { ... },
  "timezone": "America/New_York",
  "inboundPhoneNumber": "+15551234567",
  "monthlyMinuteLimit": 1000
}
```

**Response (200):**
Same shape as GET response.

**Errors:**
- 400: Invalid field, timezone, or phone number format
- 403: User is AGENT role (read-only)

---

## Call Endpoints

### GET /api/calls

List calls for the tenant (paginated, with search and filters).

**Query Parameters:**
- `page` (int, default 1): Page number
- `perPage` (int, default 25): Items per page (max 100)
- `search` (string): Search in caller name or phone
- `sinceDays` (int, default 30): Only calls from the last N days
- `sort` (string, default "createdAt:desc"): Sort by `createdAt:asc|desc` or `durationSeconds:asc|desc`

**Example:** `GET /api/calls?page=1&perPage=25&search=sarah&sinceDays=7&sort=createdAt:desc`

**Response (200):**
```json
{
  "calls": [
    {
      "id": "call-123",
      "direction": "INBOUND",
      "callerName": "Sarah Chen",
      "phoneNumber": "+16045550188",
      "startsAt": "2026-06-18T14:30:00Z",
      "endsAt": "2026-06-18T14:45:23Z",
      "durationSeconds": 893,
      "status": "COMPLETED",
      "endedReason": "CALL_ENDED",
      "aiSummary": "Caller inquired about appointment availability for a cleaning. Booked for June 25 at 2pm.",
      "billedCostCents": 45,
      "createdAt": "2026-06-18T14:46:00Z"
    },
    ...
  ],
  "page": 1,
  "perPage": 25,
  "total": 142
}
```

---

### GET /api/calls/stats

Get call statistics for the dashboard.

**Query Parameters:**
- `days` (int, default 7): Number of days to look back (7, 30, or 90)

**Response (200):**
```json
{
  "totalCalls": 42,
  "completedCalls": 41,
  "failedCalls": 1,
  "totalDurationSeconds": 3142,
  "avgDurationSeconds": 74,
  "totalBilledCents": 2100,
  "topCallers": [
    { "name": "Sarah Chen", "count": 3 },
    { "name": "John Doe", "count": 2 }
  ],
  "afterHoursShare": 0,
  "period": "7 days"
}
```

---

### GET /api/calls/:id

Get a single call detail (includes transcript and one-time media token).

**Response (200):**
```json
{
  "id": "call-123",
  "direction": "INBOUND",
  "callerName": "Sarah Chen",
  "phoneNumber": "+16045550188",
  "startsAt": "2026-06-18T14:30:00Z",
  "endsAt": "2026-06-18T14:45:23Z",
  "durationSeconds": 893,
  "status": "COMPLETED",
  "endedReason": "CALL_ENDED",
  "aiSummary": "Caller inquired about appointment availability for a cleaning. Booked for June 25 at 2pm.",
  "transcript": [
    { "role": "agent", "speaker": "Maya", "text": "Hi! This is Maya with ACME Corp. How can I help you?", "startsAt": "2026-06-18T14:30:05Z" },
    { "role": "caller", "speaker": "Sarah", "text": "Hi Maya, I'd like to book an appointment.", "startsAt": "2026-06-18T14:30:10Z" },
    ...
  ],
  "recordingUrl": "https://voicefrontapi-production.up.railway.app/api/media/eyJhbGc...",
  "mediaToken": "eyJhbGc...",
  "mediaTokenExpiresAt": "2026-06-18T14:51:00Z",
  "billedCostCents": 45,
  "createdAt": "2026-06-18T14:46:00Z"
}
```

**Errors:**
- 404: Call not found

---

### GET /api/media/:token

Proxy a recording (use the URL from the call detail). Supports HTTP `Range` headers for seeking.

**Response (206 or 200):**
```
Content-Type: audio/mpeg (or other MIME type from Vapi)
Content-Length: 1234567
[binary audio data]
```

**Errors:**
- 401: Invalid or expired token
- 404: Recording not found

---

## Voice Endpoints

### POST /api/voice/web-session

Start an in-browser test call. Returns the Vapi public key and a transient assistant.

**Request:**
```json
{
  "name": "Alice"
}
```

**Response (200):**
```json
{
  "publicKey": "...",
  "assistant": {
    "id": "...",
    "name": "Maya · ACME Corp",
    "firstMessage": "Hi Alice! This is Maya with ACME Corp. How can I help you?",
    "model": {
      "provider": "openai",
      "model": "gpt-4",
      "temperature": 0.7,
      "messages": [
        {
          "role": "system",
          "content": "You are a friendly receptionist for ACME Corp..."
        }
      ],
      "tools": [
        {
          "type": "function",
          "function": {
            "name": "checkAvailability",
            "description": "Returns open appointment slots for one calendar day.",
            "parameters": { ... }
          }
        },
        {
          "type": "function",
          "function": {
            "name": "bookAppointment",
            "description": "Books a confirmed appointment...",
            "parameters": { ... }
          }
        }
      ]
    }
  },
  "sessionId": "session-123"
}
```

**Errors:**
- 503: Vapi not configured (no public key)

---

## Appointments Endpoints

### GET /api/appointments

List appointments for the tenant (in a date range).

**Query Parameters:**
- `from` (string, required): Start date (YYYY-MM-DD)
- `to` (string, required): End date (YYYY-MM-DD)

**Response (200):**
```json
{
  "appointments": [
    {
      "id": "apt-123",
      "customerName": "Sarah Chen",
      "customerPhone": "+16045550188",
      "reason": "Cleaning",
      "startsAt": "2026-06-25T14:00:00Z",
      "endsAt": "2026-06-25T14:30:00Z",
      "timezone": "America/Los_Angeles",
      "local": {
        "date": "2026-06-25",
        "time": "14:00"
      },
      "status": "CONFIRMED",
      "source": "VOICE_AGENT",
      "createdAt": "2026-06-18T14:46:00Z"
    },
    ...
  ]
}
```

---

### GET /api/appointments/availability

Get free slots for one day (respects business hours, tenant timezone).

**Query Parameters:**
- `date` (string, required): Date in YYYY-MM-DD format (in tenant's timezone)

**Response (200):**
```json
{
  "availability": {
    "open": true,
    "dayLabel": "Wednesday, June 25, 2026",
    "freeSlots": [
      "09:00", "09:30", "10:00", "10:30",
      ...
      "16:00", "16:30"
    ]
  }
}
```

**If closed:**
```json
{
  "availability": {
    "open": false,
    "dayLabel": "Sunday, June 22, 2026",
    "freeSlots": []
  }
}
```

---

### POST /api/appointments

Create a new appointment (manual booking by user).

**Request:**
```json
{
  "customerName": "Sarah Chen",
  "customerPhone": "+16045550188",
  "reason": "Cleaning",
  "date": "2026-06-25",
  "time": "14:00",
  "durationMinutes": 30
}
```

**Response (201):**
```json
{
  "appointment": {
    "id": "apt-456",
    "customerName": "Sarah Chen",
    "customerPhone": "+16045550188",
    "reason": "Cleaning",
    "startsAt": "2026-06-25T14:00:00Z",
    "endsAt": "2026-06-25T14:30:00Z",
    "timezone": "America/Los_Angeles",
    "local": { "date": "2026-06-25", "time": "14:00" },
    "status": "CONFIRMED",
    "source": "MANUAL",
    "createdAt": "2026-06-18T15:00:00Z"
  }
}
```

**Errors:**
- 409: Slot already taken (overlap detected)
- 409: Time outside business hours

---

### PATCH /api/appointments/:id

Update an appointment (status, time, customer details).

**Request:**
```json
{
  "status": "CANCELLED"
}
```

**Response (200):**
Same shape as POST response.

---

## Sales Demo Endpoints

### GET /api/demo/status

Check if the sales demo is enabled.

**Response (200):**
```json
{
  "enabled": true
}
```

---

### POST /api/demo/lead

Capture a prospect's lead info and start a demo session.

**Request:**
```json
{
  "name": "Sarah Chen",
  "email": "sarah@acme.com",
  "phone": "+1 (604) 555-0188"
}
```

**Response (200):**
```json
{
  "leadId": "lead-123",
  "sessionId": "demo_12345",
  "name": "Sarah Chen",
  "phone": "+16045550188",
  "callAllowed": true,
  "ipCountry": "CA",
  "phoneCountry": "US/CA",
  "day": {
    "date": "2026-06-18",
    "dayLabel": "Wednesday, June 18, 2026",
    "timezone": "America/Vancouver",
    "open": "08:00",
    "close": "17:00",
    "slotMinutes": 30
  },
  "appointments": [
    {
      "id": "apt-001",
      "time": "09:00",
      "label": "Team huddle",
      "kind": "seed"
    },
    ...
  ]
}
```

**Errors:**
- 403: Demo is disabled

---

### POST /api/demo/session

Start an in-browser demo session (build the Ava assistant).

**Request:**
```json
{
  "sessionId": "demo_12345",
  "leadId": "lead-123",
  "name": "Sarah Chen"
}
```

**Response (200):**
```json
{
  "publicKey": "...",
  "assistant": { ... },
  "sessionId": "demo_12345",
  "day": { ... },
  "appointments": [ ... ],
  "showCalendar": true
}
```

---

### POST /api/demo/call

Place an outbound call to a prospect (the "Get a call" button).

**Request:**
```json
{
  "sessionId": "demo_12345",
  "leadId": "lead-123",
  "name": "Sarah Chen",
  "phone": "+16045550188"
}
```

**Response (200):**
```json
{
  "ok": true,
  "callId": "call-456",
  "fromNumber": "+1 (604) 555-9999",
  "country": "CA"
}
```

**Errors:**
- 403: Call not allowed (not US/CA)
- 400: Invalid phone number
- 503: No demo numbers configured

---

### GET /api/demo/appointments

Poll for live appointment updates during a demo (visitor's isolated calendar).

**Query Parameters:**
- `sessionId` (string, required): The session ID from lead capture

**Response (200):**
```json
{
  "appointments": [
    { "id": "apt-001", "time": "09:00", "label": "Team huddle", "kind": "seed" },
    { "id": "apt-002", "time": "09:30", "label": "Sarah Chen - Consultation", "kind": "voice" },
    ...
  ]
}
```

---

### POST /api/demo/block

Block a time slot (prospect clicks on the calendar to test double-booking).

**Request:**
```json
{
  "sessionId": "demo_12345",
  "date": "2026-06-18",
  "time": "10:00"
}
```

**Response (200):**
```json
{
  "appointments": [ ... ]
}
```

---

### POST /api/demo/reset

Reset the visitor's calendar (remove all voice bookings, keep seed slots).

**Request:**
```json
{
  "sessionId": "demo_12345"
}
```

**Response (200):**
```json
{
  "day": { ... },
  "appointments": [ ... ]
}
```

---

## Admin Endpoints

### GET /api/admin/demo/sales-config

Get the sales demo configuration (admin only).

**Response (200):**
```json
{
  "agentName": "Ava",
  "founderName": "our founder",
  "showCalendar": true
}
```

---

### PATCH /api/admin/demo/sales-config

Update the sales demo configuration.

**Request:**
```json
{
  "agentName": "Ava",
  "founderName": "Alice",
  "showCalendar": false
}
```

**Response (200):**
Same shape as GET response.

---

### GET /api/admin/demo/numbers

Get available Vapi numbers and assigned demo numbers.

**Response (200):**
```json
{
  "available": [
    { "id": "num-001", "number": "+1 (604) 555-0123" },
    { "id": "num-002", "number": "+1 (416) 555-0456" },
    { "id": "num-003", "number": "+1 (604) 555-7890" }
  ],
  "assigned": {
    "us": { "id": "num-001", "number": "+1 (604) 555-0123" },
    "ca": null
  }
}
```

---

### PATCH /api/admin/demo/numbers

Assign demo caller-ID numbers.

**Request:**
```json
{
  "us": { "id": "num-001", "number": "+1 (604) 555-0123" },
  "ca": { "id": "num-002", "number": "+1 (416) 555-0456" }
}
```

**Response (200):**
Same shape as GET response.

---

### GET /api/admin/demo/calls

Get recent demo calls (for founder review).

**Response (200):**
```json
{
  "calls": [
    {
      "id": "democall-123",
      "durationSeconds": 432,
      "endedReason": "CALL_ENDED",
      "summary": "Prospect booked a consultation. Plans to explore the product further.",
      "transcript": "Maya: Hi! This is Ava...\nSarah: ...",
      "recordingUrl": "https://voicefrontapi-production.up.railway.app/api/media/token",
      "createdAt": "2026-06-18T14:30:00Z",
      "lead": {
        "name": "Sarah Chen",
        "email": "sarah@acme.com",
        "phone": "+16045550188",
        "mode": "web"
      }
    },
    ...
  ]
}
```

---

### GET /api/admin/founder/calendar

Get founder's calendar entries (blocks + booked planning calls).

**Query Parameters:**
- `from` (string, required): Start date (YYYY-MM-DD)
- `to` (string, required): End date (YYYY-MM-DD)

**Response (200):**
```json
{
  "entries": [
    {
      "id": "entry-123",
      "kind": "block",
      "label": "Lunch",
      "reason": null,
      "startsAt": "2026-06-18T12:00:00Z",
      "endsAt": "2026-06-18T13:00:00Z",
      "timezone": "America/Vancouver",
      "local": { "date": "2026-06-18", "time": "12:00" },
      "durationMinutes": 60,
      "status": "CONFIRMED"
    },
    {
      "id": "entry-456",
      "kind": "call",
      "label": "Sarah Chen - Planning call",
      "reason": "Planning call with Sarah Chen",
      "startsAt": "2026-06-18T14:00:00Z",
      "endsAt": "2026-06-18T14:15:00Z",
      "timezone": "America/Vancouver",
      "local": { "date": "2026-06-18", "time": "14:00" },
      "durationMinutes": 15,
      "status": "CONFIRMED"
    },
    ...
  ],
  "timezone": "America/Vancouver"
}
```

---

### GET /api/admin/founder/availability

Get founder's free slots for a given day.

**Query Parameters:**
- `date` (string, required): Date in YYYY-MM-DD format

**Response (200):**
```json
{
  "availability": {
    "open": true,
    "dayLabel": "Wednesday, June 18, 2026",
    "freeSlots": [
      "08:00", "08:30", "09:00", "09:30",
      ...
      "11:30",
      "13:00", "13:30",
      ...
      "17:00", "17:30"
    ]
  }
}
```

---

### POST /api/admin/founder/block

Block time on the founder's calendar.

**Request:**
```json
{
  "date": "2026-06-18",
  "time": "12:00",
  "durationMinutes": 60,
  "label": "Lunch meeting"
}
```

**Response (201):**
```json
{
  "entry": {
    "id": "entry-789",
    "kind": "block",
    "label": "Lunch meeting",
    "reason": null,
    "durationMinutes": 60,
    "status": "CONFIRMED",
    ...
  }
}
```

---

### DELETE /api/admin/founder/calendar/:id

Remove a block or cancel a booked planning call.

**Response (200):**
```json
{
  "ok": true
}
```

---

## Webhook: POST /api/vapi/inbound

Vapi sends webhooks to this endpoint for:
1. **assistant-request:** incoming call, request for assistant config
2. **end-of-call-report:** call finished, report with transcript + recording

**Headers (required):**
```
x-vapi-secret: <webhook-signing-secret>
Content-Type: application/json
```

**Example assistant-request payload:**
```json
{
  "type": "assistant-request",
  "call": {
    "id": "call-123",
    "phoneNumber": {
      "number": "+15551234567",
      "type": "inbound"
    }
  }
}
```

**VoiceFront must respond with:**
```json
{
  "assistant": {
    "id": "...",
    "name": "Maya",
    "firstMessage": "Hi! This is Maya with ACME Corp. How can I help you?",
    "model": { ... },
    "tools": [ ... ]
  }
}
```

**Example end-of-call-report payload:**
```json
{
  "type": "end-of-call-report",
  "call": {
    "id": "call-123",
    "startedAt": "2026-06-18T14:30:00Z",
    "endedAt": "2026-06-18T14:45:23Z",
    "endedReason": "CALL_ENDED",
    "summary": "Prospect booked an appointment for June 25 at 2pm.",
    "transcript": [ ... ],
    "recording": {
      "url": "https://recording.vapi.ai/...",
      "format": "mp3"
    },
    "cost": {
      "total": 45,
      "currency": "cents"
    }
  }
}
```

**VoiceFront responds:**
```json
{
  "ok": true
}
```

**Important:**
- Always respond 200, even on error → prevents Vapi retry loops
- Webhook handler is idempotent (upserts on external call ID)
- Secret must match VAPI_WEBHOOK_SECRET in API env

---

## Health Check

### GET /api/health

Liveness check (no auth required).

**Response (200):**
```json
{
  "status": "ok",
  "timestamp": "2026-06-18T15:00:00Z"
}
```

---

## Rate Limiting

- **Auth endpoints** (`/api/auth/register`, `/api/auth/login`): 20 requests per 15 minutes per IP
- **Other endpoints:** No specific limit (tenants may hit Vapi rate limits)

Response headers include:
```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 18
X-RateLimit-Reset: 1234567890
```

---

**Last updated:** June 2026  
**Version:** 1.0
