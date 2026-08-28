# Secrela API

Node.js + Express + TypeScript backend for [Secrela](https://secrela.com).

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Health check: `http://localhost:4000/health`

## Production

- Set `NODE_ENV=production`
- Configure MongoDB Atlas, session secret, encryption keys, SMTP, Google OAuth, and Lemon Squeezy in `.env`
- See `docs/billing-setup.md` in the monorepo docs (or Hostinger deploy guide) for billing webhooks

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production build |
| `npm test` | Unit tests |
