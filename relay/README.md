# The Maris relay

The relay is what lets the phone app reach Maris away from home: on mobile data, at work, on another
Wi-Fi. Maris on the computer and the phone both connect *out* to the relay, so nothing has to be opened
on the home router, and it works behind any kind of internet connection.

It is a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) with one
[Durable Object](https://developers.cloudflare.com/durable-objects/) per computer (a "room").

## What it sees, and what it does not

Every message between Maris and the phone is encrypted end to end with the key that the computer and
the phone agreed on when they were paired (AES-256-GCM, see `src/main/link/protocol.ts`). The relay
gets that key at no point. It passes messages on and can read none of them.

What the relay does see: a room id (a hash, the same for one computer), the device ids of the phones,
the IP addresses that connect, and when and how much is sent. It stores nothing: no messages, no logs
of its own (Cloudflare's observability is off in `wrangler.toml`).

Who may do what:

- **The computer** proves it holds the room key; the room id is a SHA-256 of that key, so a phone that
  knows the id cannot take the computer's place.
- **A phone** gives its device id. Anything it sends goes to the computer only, never to other phones.
  The computer then checks that every request is sealed with that phone's own key.
- **Pairing through the relay** is as safe as at home: the one-time code is never sent, it is part of the
  key exchange, and the computer cancels it after a few wrong tries.

## Deploy it (once)

You need a Cloudflare account; the Workers **Free** plan is enough to start with.

```bash
cd relay
npx wrangler@4 login
npx wrangler@4 deploy
```

`login` opens Cloudflare in the browser to sign in. `deploy` prints the relay's address, for example
`https://maris-relay.<your-subdomain>.workers.dev`. Open it in a browser: it answers "Maris relay".

Then make it the relay every copy of Maris uses: put its address, with `wss://`, in `DEFAULT_RELAY_URL` in
[`src/shared/relay.ts`](../src/shared/relay.ts) and release a new version. Until then (or for a relay of
your own), enter the address in **Settings → Phone → Relay address**.

To change the relay later, edit `src/` and run `npx wrangler@4 deploy` again; rooms reconnect by
themselves.

## What it costs

On the Free plan, Cloudflare counts requests and the time a room is awake. The relay uses WebSocket
hibernation, so an idle room costs nothing, and keep-alive pings are answered without waking it. A
phone that is connected gets a few small messages a minute, more while an answer streams. A handful of
people fit in the free allowance; if many people use Maris through the relay, the Workers Paid plan
(5 USD a month at the time of writing) covers a lot more. Check Cloudflare's current pricing.

## Limits

- Up to 16 phones per computer.
- Messages up to 1 MiB each; Maris sends bigger ones (pictures, videos, uploads) in parts.

## Testing

`tests/relay.test.ts` checks the room rules (`src/room.mjs`) and `tests/e2e/link-relay.mjs` runs the
phone app against Maris through a stand-in relay (`tests/e2e/fixtures/mock-relay.mjs`) that uses the same
room rules, so neither needs a Cloudflare account.
