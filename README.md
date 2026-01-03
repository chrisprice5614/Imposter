# Imposter

Mobile-first Express + EJS + Socket.IO multiplayer lobby/game scaffold.

- Port: 2026
- No partials; uses EJS includes
- Names and room codes: uppercase letters A–Z only (auto-formatted)
- Room code: 4 letters (e.g., ABCD)
- Max players per room: 20
- Min players to start: 3 (host only)
- Countdown: 3 seconds, host can cancel

## Run

```bash
npm run dev
```

Open http://localhost:2026

## Scripts

- `npm run start`: Production run
- `npm run dev`: Nodemon dev with auto-restart

## Notes

The original request mentioned a "four digit room code" but also required letters-only inputs. This implementation uses a four-letter uppercase room code to satisfy the validation constraint. Update generation/validation in `server.js` and UI placeholders if you prefer digits.
