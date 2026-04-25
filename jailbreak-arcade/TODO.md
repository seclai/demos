# Roadmap

Core work still to do before this is production-ready:

- [ ] Add Cloudflare D1 database + schema (users, attempts, votes)
- [ ] Migrate Storage layer from KV to D1 (keep KV for rate limits)
- [ ] Add auth (GitHub OAuth via Lucia, or Clerk)
- [ ] Add user profiles: handle, avatar, attempt history page
- [ ] Persist all attempts (not just Broken) linked to user_id
