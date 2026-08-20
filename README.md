# Who Does What

A shared calendar and task divider for a small crew. Add the work, split it across
the people, drop it on a day and an hour.

No framework, no build step. Three static files and one serverless function.

## What it does

- **Month calendar** with unlimited forward and back navigation, today marked, and
  a tray for anything not yet scheduled.
- **Week view with time slots**, the way a calendar you already know does it: the
  hours down the side, the seven days across, half-hour slots to drop work into, an
  all-day row above them, and a red line across today at the current time. Click a
  date in the month grid to open its week.
- **Give a task a time** by dropping it on a slot, or by aiming a slot and typing.
  Drag the bottom edge of anything on the grid to say how long it takes, in quarter
  hours. Two jobs at the same hour sit side by side rather than on top of each other.
  Drop something back on the all-day row to take the time off it again.
- **A crew of up to six**, each with their own colour. Rename anyone inline; their
  initials follow onto every task they own.
- **Hand a task to anyone, any time.** The coloured badge on a task opens a picker
  with the whole crew, what each of them is already carrying, and Nobody yet to take
  a name back off. It works the same on a chip in the month, an event in the week, or
  something still in the tray. You can also drop a task straight onto a name in the
  crew list, or tap its grip and then tap the name.
- **Split evenly by person** hands every unassigned task to whoever is carrying the
  least, so nine tasks across three people come out 3/3/3 rather than blindly round
  robin.
- **Spread across weekdays** deals the unscheduled pile onto the next ten weekdays,
  skipping weekends.
- **Clear finished tasks** sweeps everything ticked off.
- Move a task by dragging it onto a day or a time slot, or tap its grip and then tap
  where it should go, which is what you want on a phone.
- Everyone with the link sees the same board. Saves happen a moment after you stop
  typing, and other people's edits arrive within about five seconds.

Per-viewer things stay per viewer: month or week, where you are in the calendar, the
slot you have aimed new tasks at, and the task you are holding are never shared.

## Deploy it

### 1. Push and import

```bash
git remote add origin git@github.com:YOUR-NAME/who-does-what.git
git push -u origin main
```

Then import the repo at [vercel.com/new](https://vercel.com/new). There is nothing
to configure: `public/` is served as the site and `api/` becomes the function.

At this point the board works, but it saves into each person's own browser. The
page says so at the top.

### 2. Turn on sharing

In the Vercel dashboard for the project, open **Storage**, create a Redis store
(the Marketplace lists it as *Upstash for Redis*; the free tier is far more than
this needs), and connect it to the project. Vercel injects the credentials for you.

Redeploy. The banner disappears and the board is shared.

The function accepts either naming for those credentials, so it works whichever
Vercel gives you:

| Variable | Also accepted as |
| --- | --- |
| `KV_REST_API_URL` | `UPSTASH_REDIS_REST_URL` |
| `KV_REST_API_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` |

Nothing else is needed, and there are no npm dependencies in production.

## More than one board

Add `?board=` to the address for a separate board with its own crew and tasks:

```
https://your-app.vercel.app/?board=site-b
```

Names are lowercased and stripped to letters, numbers and hyphens. No `?board=`
means the board called `main`.

## Anyone with the link can edit

There is no sign-in. The URL is the key, so treat it like one, and keep the Vercel
project's deployment protection on if the board should not be public.

## How saving works

The board is one JSON document. Every change is an op applied to that document,
which makes conflicts survivable: each save carries the revision it was based on,
the function refuses it if someone else got there first, and the page then replays
its own unsaved ops on top of the winning version and saves again. Two people
working at once keep both sets of changes rather than one silently losing.

## Running it locally

```bash
npm install
npm test
```

The tests load the real page in jsdom with the network faked and drive every
interaction, including a save that loses a race, plus the function itself against
a stand-in for the store. `npm install` is only for the tests; nothing ships.

To click around locally, serve `public/` with any static server. The API will not
be there, so the page runs in its own browser-only mode:

```bash
npx serve public
```

For the real thing locally, `npx vercel dev` runs the static files and the function
together.

## Layout

```
public/index.html    the page
public/app.css       one stylesheet, light and dark
public/app.js        the whole app: state, ops, rendering, saving
api/board.js         GET and PUT the board, with compare-and-set
test/                jsdom and function tests
```
