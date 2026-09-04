---
title: '"I don''t know" is a state your UI probably doesn''t have'
published: false
tags: kubernetes, ux, testing, rust
---

Someone read the source of [Rubick](https://github.com/Dudude-bit/rubick), the
Kubernetes desktop client I maintain, and emailed me two security problems. The
worse one:

Draining a node evicts its pods. The eviction API is the part of Kubernetes
that checks a PodDisruptionBudget, the object that says "never take the last
healthy replica of this". A plain `DELETE` checks nothing.

My drain fell back to `DELETE` whenever an eviction returned an error. Any
error. And the UI passed the flag that enabled it on every single drain, so a
budget would refuse an eviction and the pod was deleted anyway a moment later.

That's a bug on its own. What sent me looking further was the dialog that was
on screen while it happened:

> The drain will not fail on these — it will wait, and keep waiting until
> another replica is ready somewhere else.

The words were right. `kubectl drain` does exactly that. Someone had written
that sentence carefully and the code underneath had never done it.

I shipped the fix. A week later a user opened an issue with a screenshot: his
gateway was working, his routes were carrying traffic, and my app had five of
them in red.

His setup runs on a private overlay network. The gateway there has no external
address, because there is nowhere external to publish one. My code read an
empty `status.addresses` and said: _"Gateway `private` has no address yet,
traffic has nowhere to arrive."_

`status.addresses` is optional in the Gateway API spec. Plenty of
implementations never fill it. I checked what my own code did by running it
rather than reading it:

```
state: err | serving: false | servingKnown: true
```

The last flag is the one that stings. It exists so that a verdict nobody
checked doesn't render as checked. My app wasn't just wrong, it was sure.

In the same issue he'd compared my output against another Kubernetes UI, which
showed his cluster as entirely fine. I want to be careful here, because the
obvious reading is that they got it right and I got it wrong. They didn't. The
other tool never looked either; it just defaults to green instead of red. Both
of us were reporting a fact nobody had established. Only one of us was going
to get complained at for it.

## The same mistake, twice more

I fixed the address check and released. He came back: still red, one step
further along.

The route now stopped at the controller's verdict, and the reason my app gave
was that either nothing claims the gateway's class or the controller isn't
running. Both of those were contradicted by the two lines directly above them
on his screen. The class _was_ claimed, by a named controller. The gateway
_was_ programmed. The controller was there. It just doesn't write status for
routes, which is common enough for the alpha kinds that I should have expected
it.

The third one arrived from the other direction, which is what made me stop
treating these as separate bugs.

A route rule can carry an `ExtensionRef` filter and no backend. Envoy Gateway's
direct-response works this way: the filter answers, no backend needed. Rubick
called that broken. A contributor sent a patch, and the patch over-corrected
into the opposite claim: _"an extension filter answers, no backends, and none
needed."_

Also not knowable. `ExtensionRef` doesn't say what the filter does. A Kong
plugin rate-limits and still needs somewhere to send the request, so a route
with a plugin and a forgotten backend would now read as healthy.

And the detail page had already been printing, four lines above:

> filters this app does not interpret: `KongPlugin.configuration.konghq.com/rate-limit`

One screen, one rule, both sentences. I can't interpret this. This answers by
itself.

## Three answers, two states

There are three answers to "is this working?" Yes, no, and I couldn't see. My
app had two, and every time the third one came up it got filed under "no".

The reason it keeps happening is that absence looks like evidence. An empty
list, a missing field, no status object: the data feels like an answer when it is
only the shape of where one would go. The difference only shows up when somebody's setup is
unusual enough to expose it, which in my case meant overlay networks and alpha
API kinds.

There's a less flattering reason too. Two states are cheaper to render. Green
tick, red cross, done. A third one means another visual treatment, another
sentence to write, and a verdict that admits what it doesn't cover.

## Naming the unknown

The fix was to put the third state in the type system rather than in prose.

```ts
export type TraceStepState = "ok" | "err" | "warn" | "off" | "blind";
```

`blind` means the step could not read its source, which is a different thing
from having read it and found nothing. The overall verdict then carries the distinction as two booleans instead
of one:

```ts
const firstBroken = steps.findIndex((step) => step.state === "err");
const unread = steps.some(
  (step) => step.state === "blind" && step.who !== "machine"
);

return {
  serving: firstBroken < 0,
  servingKnown: firstBroken >= 0 || !unread,
};
```

`serving` is what I think. `servingKnown` is whether anyone checked. A refusal
still counts as known, because an error is an answer; only silence is unknown.
On screen it's a dashed line rather than a red one, with a sentence saying what
couldn't be read.

All three bugs collapsed into the same fix:

|                      | before                          | after                               |
| -------------------- | ------------------------------- | ----------------------------------- |
| no published address | ✗ traffic has nowhere to arrive | ? publishes no address              |
| no route status      | ✗ invisible to the data plane   | ? controller wrote no verdict       |
| unread filter        | ✗ nowhere to go / ✓ none needed | ? a filter is named, and no backend |

His route now reads as serving with an unverified step in the middle. Not an
alarm, and not a promise either.

## The tests didn't notice any of this

The tests for the ExtensionRef change asserted this:

```ts
expect(trace.steps[5].say).toContain("filter");
```

I replaced the catalogue string with **"No filter answers this — the request
has nowhere to go"**, which means the opposite of what shipped, and all 24
tests stayed green.

So now I break the code on purpose and check that the tests notice. That
sounds like a ritual until it isn't: twice in one week my own sabotage failed
to fail, and I only found out because I ran it.

The first time, a rule about not chasing evicted pods' replacements turned out
to be unobservable until I added a pod that tolerates the cordon. Without that
one specimen in the scene, correct and broken code behaved identically and the
test passed either way. The second time I'd written a guard for a case that
couldn't be reached at all: an earlier step already errored and suppressed it.
I deleted the guard. Code that looks like a safety net without being
one is worse than none, because you stop checking.

## Nine hours later

I drafted the paragraph above at two in the afternoon. That evening the same
shape came back, in code I had written that morning.

A route can attach to a `ListenerSet` instead of directly to a Gateway — the
Gateway stays bare and every hostname and certificate lives in a per-app set.
Rubick was filing those routes under "not judged here". I fixed it, checked it
against a live cluster, took a screenshot, shipped it.

The same bug was alive in the next code path over. Not because anyone forgot
the rule — because of this, in the constructor:

```rust
listener_sets_known: true,
```

Two callers read a Gateway and did not go on to merge the sets in. Both
inherited a confident answer to a question nobody had asked. On a cluster where
the ListenerSet sits there in `kubectl get`, the graph reported it `Missing`.

The forgotten call was the shallow half of it. What mattered was the default:

```rust
listener_sets_known: false,
```

Only a real read sets it now, and forgetting produces "not looked at" — which
the app already knows how to draw. I checked all three states on a live
cluster: with the old default, `Missing`; with the new default and still no
merge, `NotChecked`; with both, the route finds its Gateway.

Naming the third state isn't enough if the default answer is the confident one.
The question isn't whether you remember the rule. It's what the code says when
you don't.
