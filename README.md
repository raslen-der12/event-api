# Event Platform API

Node.js API for a multi-role event management platform. It supports event operations, participant accounts, professional profiles, meetings, ticketing, messaging, notifications, exports, and administration.

## Capabilities

- Access and refresh token authentication with role-based authorization
- Attendee, speaker, exhibitor, event-manager, and administrator accounts
- Event content, schedules, galleries, programs, organizers, and polls
- Business profiles, communities, search, invitations, and participant discovery
- Meeting scheduling, calendar integration, reminders, and capacity controls
- Ticketing, billing, QR generation, refunds, and finance reporting
- Direct and group messaging with real-time Socket.IO delivery
- Administrative analytics, audit logs, moderation, exports, and broadcasts

## Technology

| Area | Technology |
| --- | --- |
| Runtime | Node.js |
| HTTP API | Express |
| Database | MongoDB, Mongoose |
| Authentication | JWT, bcrypt, Google authentication |
| Real-time | Socket.IO |
| Background work | Agenda |
| Communication | Nodemailer, Google APIs |
| Documents and exports | PDFKit, XLSX, CSV, QRCode |
| Reliability | Validation, rate limiting, structured middleware |

## Repository structure

```text
config/       Database and integration configuration
controllers/  Application and domain workflows
middleware/   Authentication, authorization, uploads, and validation
models/       Mongoose schemas
routes/       HTTP route definitions grouped by domain
scripts/      Maintenance and migration utilities
utils/        Shared infrastructure helpers
validators/   Request validation rules
server.js     Express and Socket.IO entry point
```

## Local development

Requirements:

- Node.js 20 or newer
- npm
- MongoDB

```bash
git clone https://github.com/raslen-der12/event-api.git
cd event-api
npm install
npm run dev
```

Create `.env` locally. Do not commit credentials.

```env
PORT=5000
DATABASE_URI=mongodb://127.0.0.1:27017/event-platform
ACCESS_TOKEN_SECRET=replace-me
REFRESH_TOKEN_SECRET=replace-me
FRONTEND_URL=http://localhost:3000
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

## Commands

```bash
npm run dev
npm start
```

## Related repository

The React client is maintained in [event-sip](https://github.com/raslen-der12/event-sip).

## Security

- Keep all credentials in environment variables.
- Use separate secrets and databases for development and production.
- Restrict CORS to trusted frontend origins in production.
- Rotate any credential that has ever been committed to repository history.

## Project status

This repository is a public portfolio codebase. Production data, credentials, backups, and runtime uploads do not belong in source control.
