# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.9.0] - 2026-09-05

### Added — Settings opens over any screen instead of taking over the tab

Settings was a page of whichever tab was open: it took you off the list you
were reading, renamed the tab, and stood behind every gate in front of it — so
an expired token hid the one screen that could fix it. It is now a layer over
the window, opened from the rail, with `mod+,` or from the palette, and closed
with Esc onto the page it covered. Esc with something typed in the settings
search clears the filter first, and the filter no longer survives until the
next visit.

Integrations moved out of Settings to sit beside the cluster's own screens,
where they were already addressed from.

From [#108](https://github.com/Dudude-bit/rubick/pull/108).

### Fixed — a crash-looping pod was still a Running pod to three screens

The Pods list has read the status kubectl prints since 3.0.0. Three other
readers still used `.status.phase`, which says `Running` for a pod whose
container is restarting in a loop:

- the port-forward picker offered it as a target. It now wants a pod with a
  container of its own actually running — which also keeps a pod whose sidecar
  is stuck pulling eligible while the container that serves is up;
- the infrastructure canvas drew the phase, both for imported pods and for a
  pasted manifest;
- the peek panel's sentence explaining why an action is unavailable named the
  phase rather than the status on the badge beside it.

From [#110](https://github.com/Dudude-bit/rubick/pull/110).

### Fixed — signing in with a certificate from a credential plugin

A plugin that authenticates with a client certificate — `tsh kube credentials`
among them — returns PEM, and the two kubeconfig fields it lands in are read
through a base64 decode. The certificate never reached the cluster: the request
went out anonymous and the server refused it, and the refusal named neither the
certificate nor the decode. Teleport's is `[00] access denied`, which the app
then read to you as a cluster that is switched off or behind a VPN.

Plugins that return a token were never affected.

From [#111](https://github.com/Dudude-bit/rubick/pull/111).

### Fixed — a CronJob countdown that stopped counting

The next run was worked out once and counted down from there, so it reached
zero and stayed, and the page read «через expired» above a timestamp that had
already passed. A suspended CronJob has no next run at all; it was drawn in the
colour of a deadline that has gone by, and now says what it is waiting for
instead.

### Changed — Diagnostics reports the environment the app resolved, and how

The Tools block told a binary that is absent apart from one that is present and
will not answer — the difference between installing something and finding out
that what you installed is broken.

Search paths now say where the list came from: which shell was read, how it was
started, how many variables it changed. When the shell timed out, would not
start or answered nothing, the line says that instead — and it is repeated in
amber over the Tools list, because every "not installed" there rests on a path
nobody confirmed. The app's environment is not always your terminal's, and that
difference is the whole reason a plugin can work in one and not the other.

From [#109](https://github.com/Dudude-bit/rubick/pull/109).

## [4.8.0] - 2026-09-04

### Added — sort a list by the column you are reading it for

Pods sort by status, by restart count and by how many containers are short of
ready; Nodes, Deployments and the rest sort by the columns worth sorting by.
Only columns with something real to compare offer it — a header that sorts
nothing when pressed is worse than a header that does not offer.

Requested in [#107](https://github.com/Dudude-bit/rubick/issues/107).

### Added — run a CronJob now, and edit one ConfigMap key

A CronJob's detail page can start a Job from its template without waiting for
the schedule, the same way `kubectl create job --from=cronjob/x` does, and the
Job it creates is owned by the CronJob so it is cleaned up like any other.

A ConfigMap key can be edited on its own instead of through the whole manifest.

Both from [#107](https://github.com/Dudude-bit/rubick/issues/107).

### Fixed — signing in through kubectl on Windows

An OIDC login could fail on Windows with a credential that looked malformed.
Windows consoles hand back the _rendered_ screen, so a token longer than the
console is wide came back with line breaks inside it — breaking the JSON that
carried it. Rubick now reads the credential the console meant rather than the
one it drew.

Reported in [#106](https://github.com/Dudude-bit/rubick/issues/106).

### Fixed — screens that disagreed with each other about the same object

The largest part of this release. One fact from the cluster is read in several
places; a fix that reached one reader left the others answering the old way,
and two screens said different things about one object:

- A Gateway with no address held a red badge in the sidebar while its own page
  said it was fine.
- A pod on a node that had stopped reporting was drawn as running.
- A cordoned node did not say so anywhere but its own page.
- A workload mid-rollout read **Progressing** in the list and **Ready** in the
  panel opened from it.
- A probe that had already answered sat under a line still saying nobody had
  checked.

Each of these is now answered in one place that every screen reads.

### Fixed — storage volumes spoke English in a translated window

PersistentVolumes, their claims and StorageClasses reported an age, a size and
a phase composed before the language was known, so a volume the cluster had not
finished writing said `Unknown` beside neighbours that said it in the reader's
language. They now send what the cluster wrote and the words are chosen where
the reader is.

`Released` and `Lost` are also coloured now. Both used to draw the same grey as
a completed job — including a claim whose volume is gone, which stops every pod
that mounts it.

### Added — a Tools block in Diagnostics

Settings → Diagnostics now lists kubectl, helm, kubelogin and the cloud CLIs
with the file that would run and the version it reports. A tool that is present
and will not answer is shown as exactly that, rather than as missing: the
difference is between installing something and finding out what you installed
is broken.

### Changed — the Namespaces list updates as the cluster changes

It polled while every other cluster-scoped list watched. It watches now, and
falls back to polling — saying so — if the watch cannot be established.

## [4.7.3] - 2026-08-31

### Fixed — the Connections tab called an existing ListenerSet missing

4.7.2 taught the Routes page and the Gateway's own tab that a route attaching
to a `ListenerSet` belongs to that set's Gateway. The Connections tab fetches
its Gateways down a different path, and that path never merged the sets in.

So a Gateway arrived carrying no ListenerSets and a flag saying the answer was
solid. A route naming a set then resolved to nothing, and the graph reported
the set itself as **Missing** — an object plainly there in `kubectl` — with a
stop reading that the route's Gateway does not exist.

The flag was the deeper half of it. `listener_sets_known` defaulted to _true_,
so every reader that forgot to merge inherited a confident wrong answer rather
than an honest gap. It defaults to false now, and only an actual read sets it:
forgetting degrades to "not looked at", which is a state this app already knows
how to draw. The Connections path reads the sets alongside everything else it
already asks for, so nothing costs an extra round trip.

Proved against a live cluster rather than asserted — the harness and the scene
that reproduce it are in the repository, because the defect was in what the
fetch returned and no unit test could have seen it.

## [4.7.2] - 2026-08-30

Two things a reader saw on screen and the app could not, both found by opening
it rather than by searching it.

### Fixed — a route that named a ListenerSet belonged nowhere

Gateway API 1.5 graduated ListenerSet, and keeping the Gateway bare while every
hostname and certificate lives on a per-app ListenerSet is a normal way to run
it. Rubick matched a route's `parentRefs` against Gateways only, so those routes
fell out of the Gateway's Routes tab — while the listener's own `attachedRoutes`
still counted them. Two numbers on one screen disagreed, and the controller's
was the right one.

A route that names a ListenerSet now resolves to that set's Gateway. It appears
on the tab, it is judged on the Routes page instead of being filed under mesh,
and where two ListenerSets sit on one Gateway the row says which one. Reported
in #69.

### Fixed — the interface spoke English to Russian readers

A cordoned node read "Marked unschedulable — no new pods will land here" in an
otherwise Russian interface, on the first screen the app opens. That sentence is
composed in the Rust half of the app, and every check of the translation so far
had read the frontend, where the words are not.

Six fields carried two unlike things in one string: usually the object's own
status message, which is the cluster's wording and must stay as written, and
sometimes a sentence this app composes. One type for both meant the second kind
could never reach the reader's language, and the field's own documentation
claimed only the first existed. Each now names its case, the words are chosen
where the reader's language is known, and the cluster's own words are carried
through untouched inside them.

Three more of the same kind, none of which a search for a sentence could have
found: an age with no timestamp said "Unknown" in every language, "4m ago" was
built by joining two English words rather than being a phrase, and a namespace
holding a single Ingress read "1 ingresse" — the singular was made by deleting
the last letter.

## [4.7.1] - 2026-08-30

### Fixed — a route nobody wrote a verdict about

4.7.0 stopped reading an unpublished gateway address as breakage. A reader on
a private overlay network confirmed that landed, and that their routes were
still red — one step further along.

A route whose controller wrote no status at all was read as "invisible to the
data plane", and the reason offered was that either nothing claims the
gateway's class or the controller is not running. On the same screen, two
lines above, the app had already said the class was claimed and the gateway
programmed. The controller was there; it simply writes no status for routes,
which several implementations still do not for the alpha kinds — TCPRoute
among them.

That step now reads as unread rather than broken, and the five checks below it
run instead of being skipped, so what the backend and endpoints say is
visible.

## [4.7.0] - 2026-08-30

Draining a node no longer goes around a PodDisruptionBudget, and it waits the
way `kubectl` does. Two of the problems fixed here were reported privately by
a reader who went looking through the source rather than waiting to be bitten
by it.

### Fixed — a drain that keeps the budget it shows you

Draining a node used to answer a refused eviction with a direct delete. The
eviction API is the thing that consults a PodDisruptionBudget; a delete simply
goes around it. So a budget that refused to let a pod go had that pod taken
anyway, a moment later — while the dialog on screen was saying the drain would
wait for it.

It evicts, and only evicts. There is no setting that brings the old behaviour
back.

### Added — the waiting the dialog was promising

A drain now keeps asking, as `kubectl drain` does: what can move, moves, and
what a budget is holding is asked about again until it lets go. The dialog
stays open and says which attempt it is on, what has left and who is still
being waited for, and you can stop it at any point. Closing the window does
not stop it — the pods are already moving.

"Drained" now means the pods are gone rather than that the API accepted the
request. An eviction is a graceful delete, and a pod with a slow shutdown is
still on the node minutes after its eviction was agreed to.

Which pods a drain touches is two separate choices now, both off until you
make them: pods no controller would replace, and pods holding an emptyDir.
Each says what it ends. Static pods are left where they are — they belong to
the node, and the kubelet would put them straight back.

### Fixed — credentials on disk

`config.toml` holds the Prometheus and Loki tokens and the registry password,
and was written readable by anyone else with an account on the machine. It is
now owner-only and written atomically, and a file from an older version is
tightened the first time it is read. The registry form says where the password
lands, which until now only the integration form did.

### Fixed — two Gateway API false alarms

A rule that hands off to an extension filter and names no backend is
configuration rather than breakage: Envoy Gateway's direct responses are built
this way. Rubick no longer reports it as broken. It does not report it as fine
either — what a vendor filter does is that vendor's business, so the row reads
unverified instead of either.

A gateway that publishes no address is no longer read as a gateway with
nowhere for traffic to arrive. That field is optional, and an implementation on
a private network has nothing to put in it. A gateway genuinely waiting for an
address says so, and still reads as broken.

### Added — an AppImage, and Homebrew

Linux builds carry an `.AppImage` beside the `.deb` and `.rpm`: one file, with
nothing to install. On macOS,
`brew install --cask Dudude-bit/tap/rubick`.

## [4.6.0] - 2026-08-27

Gateway API, end to end. Routes, gateways, classes and policies are pages of
their own; a route says whether it is serving and, where it is not, which of
the eight links between a listener and a pod is the one that broke. A map
draws the whole road when the list is not enough, and a probe from your own
machine answers the last question the cluster cannot: whether any of it is
reachable from here.

### Added — the routes page

Every route in scope, of all five kinds, on one list: what it serves, what is
behind it, and which gateway carries it. Serving and not-serving are separate
groups, the broken ordered by how early they break. Mesh routes — the ones
attached to a Service rather than a gateway — are kept out of the judging and
named in their own place, because nothing about a gateway applies to them.

A filter narrows by name, host or gateway. A one-pixel mark in the sidebar
says whether anything is wrong before you open the page, and says nothing at
all while the verdicts are still being read.

### Added — the trace

Open a route and the eight links are laid out in the order you would debug
them: the class, the gateway, its listener, the namespace, the references,
the backend, its endpoints, and whether the address answers. The first break
is expanded with the controller's own words; the rest stay folded.

A trace that could not read something says so instead of guessing. A reader
whose rights stop at one namespace cannot see the cluster-wide gateway list,
and a green verdict drawn without it would be a claim nobody checked.

### Added — probes from this machine

DNS and TCP, on demand and never automatically: the packets leave your
network, and "reachable from here" is only an honest answer when you asked
for it. A published address that is a hostname is resolved before it is
compared, so a cloud load balancer no longer reads as a mismatch.

### Added — the map

Listeners, kinds, routes, backends and the workloads behind them, in columns,
with the verdict on every edge. Route kinds carry their own hue so the same
route reads the same at both zooms.

### Added — gateways, classes and policies

Gateways list their listeners and how many routes each carries; a listener's
port dials straight into the traffic chain. Classes say who claimed them.
BackendTLSPolicy attachment is shown where it applies and reverse-looked-up
from the backend it targets. All of it joins the cross-cluster search.

### Fixed — a namespace's contents, and what the peek says about them

Peeking a namespace lists what lives in it. Peeking a gateway shows its spec
and live policy attachment. Hostnames and addresses are one click from the
clipboard, and a Service's ports forward on click, as they do everywhere else.

## [4.5.1] - 2026-08-27

### Fixed — a filtered feed that found nothing said the scope was empty

The events limit buys a pool of the latest N, and the filter narrows what
survives it — two different ceilings. The "latest 500" note was worked out
from the survivors, so three matches out of a pool that stopped at five
hundred reported as uncapped, and the note vanished in exactly the case
where it mattered. The empty message then asserted absence: "there are no
events matching X in prod", about a search that had read the newest five
hundred.

It now says which of the three happened — the scope is quiet, the query
missed everything that was read, or it missed everything that was read and
the reading stopped at the limit. The last one names the limit and says to
raise it.

## [4.5.0] - 2026-08-27

Two kubeconfig files can be open at once, each cluster remembers the
namespaces you left it on, the events feed takes a filter, and a screen you
have no rights to says so before you walk into it. The window also speaks
Russian now — all of it, including the sentences that explain why traffic
is not arriving.

### Added — several kubeconfig files at once

A work file and a home file, without pasting them into one. Files merge the
way `kubectl` merges `$KUBECONFIG` — kube's own rule, first to name a
context keeps it — and Settings → Clusters lists them in that order with
what each one contributed. Which file a cluster came from is on the
cluster's own row too, which once two files are in play is the one thing
the row cannot be worked out from.

`$KUBECONFIG` naming several files goes down the same path as pinning
several. It always merged them, but through a reader that merges internally
and then says nothing about where any of it came from, so every row read
"every context here is also in a file above".

### Added — each cluster keeps the namespaces you left it on

Switching context cleared the scope, so somebody with rights to two or
three namespaces in each of six clusters reselected them on every move. The
window remembers per context now and restores on the way back; a cluster it
has never been asked about still opens on the whole thing. The whole
selection is kept, not just the first namespace.

### Added — the events feed takes a filter

The feed arrives as one stream and the only knob was Warning/Normal, so
finding what one group of pods did meant reading past everything else the
cluster said in the same minute. The filter matches the words the row shows
— the reason, the object, its namespace and the message — as a plain
case-insensitive substring, taken literally. It is applied before the
"latest N" cut rather than after it, so the search reaches the whole pool
the reader asked for.

### Added — what you may not see is marked before you walk into it

An account without rights over nodes or volumes met the same wall on every
visit: click, wait, read a paragraph of Kubernetes telling them what they
are not. The nav asks the cluster's own authorizer — `SelfSubjectAccessReview`,
not a reading of RBAC this app would have to interpret — and marks the rows
it refuses. Marked, never disabled: a review that is wrong costs a mark the
next answer clears, rather than a screen somebody could have used and
cannot open. Rights differ per namespace, so each selected one is asked and
any yes is a yes.

A refusal also stops reading as a fault. "Could not read Pods" describes
something broken and invites a retry that will be refused identically; the
page now says the account was refused, and by which rule.

### Added — the window speaks Russian

Not only the chrome. The sentences that carry the app's actual work are
translated too: why a Service publishes no endpoints, what an autoscaler
will undo, why a certificate never issued, what a proxy could not read
about itself. Statuses and kind names stay as the cluster writes them,
because the colour of a badge is chosen by matching that text.

The language is under Settings → Appearance, and the settings search still
finds a row by its English name — `kubectl` finds the tools row whichever
language the window is in.

### Fixed — a restart that stopped being news

A restart count is a running total that never falls, and the rule was
"count >= 5 and Running" with nothing about when. Once a pod crossed the
threshold it was reported for the rest of its life: a bare-metal cluster
was rebooted, every pod on it restarted, and two days later the Overview
badge still said one problem — about a pod that was Running, 7/7 ready and
had not restarted since. It counts as restarting only if the last restart
was recent, and the row is dated by the restart rather than by the pod.

### Fixed — a namespace named `all`

`all` is a legal namespace name, and the cache used the word to mean "every
namespace" — so a namespace actually called `all` and the whole cluster
shared one entry, and whichever asked first answered for both.

### Fixed — port-forwarding, shells and applying

Stop now reaches the bytes rather than only the bookkeeping, a forward
started from a saved config has a Stop button, and a shell that exits ends
its session instead of leaving a dead terminal open. Applying a manifest
applies every document in it, not the first one.

### Fixed — smaller things that were wrong in the same direction

A quantity of a petabyte read as one byte. A killed command kept running.
An empty pod list meant two different things and said one. A 403 asked the
error's shape instead of its code. An owner reference addressed nothing. A
heading contradicted the error printed beneath it.

## [4.4.2] - 2026-08-22

Signing in to a cluster that uses an OIDC auth-provider no longer opens a
browser at all — which is what `kubectl` has always done with the same
kubeconfig — and the two pickers still drawn by the operating system now
match the rest of the window.

### Fixed — an OIDC cluster signs in the way kubectl does

A kubeconfig whose user has an `auth-provider: oidc` block already carries
the tokens that prove who you are, and `kubectl` spends them: the
`id-token` until it expires, then the `refresh-token` for a fresh one.
Neither step involves a browser, and neither needs a redirect URI
registered with anybody.

Rubick read none of that and opened a browser every time, which asks your
provider to have allowed an address this kind of config never needed. On a
cluster somebody used daily through `kubectl`, that came back as
"Unregistered redirect_uri" with no way past it.

It now uses the token in the file, refreshes it once that is spent, and
writes the replacement back where `kubectl` will find it. The browser is
left for the case where there is nothing to refresh — and while it waits,
it names the address it is waiting on, instead of mentioning it only when
the wait runs out three minutes later.

### Fixed — the kubeconfig is edited rather than rewritten

Writing the refreshed token back used to re-emit the whole document. A
quoted `"no"` belonging to an entirely different user came back bare, and
`kubectl` reads YAML 1.1, where that is a boolean — so refreshing one user
made the file unparseable for every context in it. Comments disappeared
the same way.

Two lines change now and nothing else does. A `~/.kube/config` that is a
symlink stays one: the replacement used to land on the link itself and
leave the real file holding a token that no longer worked.

### Fixed — a provider behind a private CA is reachable

`idp-certificate-authority-data` and `idp-certificate-authority` are read
from the kubeconfig, the same two keys `kubectl` reads. Without them a
self-hosted provider signed by a company CA failed at the TLS handshake,
and the sign-in fell back to a browser that could not help either.

### Fixed — the language and namespace pickers match the window

Both were native `<select>` elements, which the operating system paints in
its own colours rather than the app's — the same thing reported for the
Service and port pickers after 4.4.0. They use the app's own list now, and
a lint rule keeps the next one from reaching a release.

## [4.4.1] - 2026-08-21

Four things that reached a screen and should not have: a sign-in that
never got past the provider, a coverage panel calling a live cluster
somebody else's, two pickers painted white in a dark window, and a
handful of labels showing their own placeholders.

### Fixed — OIDC sign-in reaches the provider

The redirect URI Rubick sent was `http://127.0.0.1:8000/callback`. What
`kubectl oidc-login` sends, and what a provider therefore has on file, is
`http://localhost:8000` — a different host, and no path. A provider
compares the whole string, so the flow stopped with an invalid-redirect
error before anyone could approve anything. Dex is lenient about both;
Keycloak, Okta and Entra are not.

### Fixed — a cluster that answers is not a foreign one

The Prometheus coverage panel asks a server which nodes it knows. A server
scraping only cAdvisor answers `kube_node_info` with nothing — and nothing
was read as "those are somebody else's nodes", so the panel called the
cluster unwatched while the graphs beside it were drawing its data. An
empty answer now means the question does not apply, and the count comes
from the metrics that are actually there.

### Fixed — the Service and port pickers match the window

Both were native `<select>` elements, which the system paints white
whatever the app's theme. They use the same picker as the rest of
Settings now.

### Fixed — labels that showed their own placeholders

Four strings reached the screen with `{label}` or `{site}` still in them,
and three Russian counters dropped the number in the form that also covers
21, 31 and 41 — so twenty-one rows announced themselves as one row. A test
now holds both halves of that contract in every language.

## [4.4.0] - 2026-08-20

The interface speaks Russian, a seven-day certificate stops wearing a
warning it earned at birth, and a Prometheus-compatible server can be
pointed at rather than searched for.

### Added — the interface speaks Russian

Chosen in **Settings → Appearance → Language**, and matching the system
by default. German, French, Spanish and Chinese are offered too, marked
_not translated yet_: the scaffolding is done and each is one file away.

What gets translated is the app's own words — buttons, section captions,
column headers, empty states, settings, counts. What does not is the
cluster's:

- **Kubernetes kind names** stay as the API spells them. `Pods`, not
  «Поды». The interface has to agree with what you type into `kubectl
get` and with what you will search for.
- **Statuses** stay too, and for a sharper reason: a badge's colour is
  chosen by matching the status text, so a translated `CrashLoopBackOff`
  would turn every badge grey. A lint rule now rejects the mistake at the
  call site.
- **Product names** — Helm, Prometheus, Traefik — are names.

Counts decline properly: «1 под / 2 пода / 5 подов», with the form picked
by `Intl.PluralRules` rather than by the one-or-many ternary that only
English can live with.

Adding a language is one file and no code. The Russian catalogue's type is
derived from the English one, so a key left untranslated is a build error
rather than a blank label on somebody's screen. `CONTRIBUTING.md` has the
rest.

### Fixed — a seven-day certificate no longer reads as almost expired

Let's Encrypt's short-lived profile issues certificates for seven days.
The marks that say _act soon_ and _this is an interrupt_ were fourteen
days and three, absolute — so a seven-day certificate was born inside the
warning and wore it for its whole life. A mark that is always on is a mark
nobody reads.

The thresholds are caps now, not the rule: on a short certificate they
shrink to a third and a tenth of its lifetime, which puts the warning
exactly where cert-manager plans to renew. A ninety-day certificate never
notices the difference.

Three things came with it. cert-manager's own `renewalTime` is read where
it exists, so a renewal that has come and gone is reported as overdue
rather than left to be inferred from a date. Certificates expiring inside
one day used to tie on whole days and fall back to alphabetical order,
which is the hour the order matters most; they rank by the exact time
left. And a sub-hour reading said `expires in 0 hours` — it counts in
minutes.

### Fixed — every integration read is keyed to its cluster

`["integration-facts", vendor.id]` was not keyed by context, with a 60s
cache and no invalidation on switch: the second cluster was never asked,
and its integrations row showed the first one's answer. A stale count is
wrong; "1 renewal overdue" pointed at the wrong cluster is an accusation.

### Added — point at a Service the search cannot recognise

"Find Prometheus in this cluster" matches a Service by the vendor's name
and label, which is useless for anything that merely speaks the API. A
VictoriaMetrics is called `vmsingle`, wears no Prometheus label, listens
on 8428, and answers the same queries.

Teaching the search about it would not have been enough, and the reporter
said why: VictoriaMetrics does not serve the query API at the root, and
where it does serve it depends on which VictoriaMetrics it is — VMSingle
under `/prometheus`, a VMCluster's vmselect under
`/select/<tenant>/prometheus`. Nothing on the Service says which.

So there is a second way in: any Service in the cluster, any of its ports,
and the subpath the API sits under. The first three are chosen from what
the cluster has rather than typed; only the subpath is typed, because only
the subpath is something the cluster cannot tell us. It is saved with the
forward, so waking the connection tomorrow rebuilds the same address.

A direct address already worked and is unchanged —
`http://host:8428/prometheus` has always reached a VMSingle.

### Fixed — the AUR package's contract fails in CI, not in pacman

`rubick-kubernetes-bin` fetches `Rubick_<version>_amd64.deb` and five
icons by raw URL. Renaming the product or tidying the icon folder would
have broken the package one release later, on its maintainer, with nothing
in this repository looking wrong. A test reads the config and the folder
and says so in the pull request instead.

## [4.3.0] - 2026-08-17

Four changes, three of them from one person's first hour with the app and
one from a comment under the release post. All four are the same shape:
the app said something confident that was not true, or said nothing at
all where it knew better.

### Fixed — a plugin that was installed, reported as missing

A kubeconfig context authenticating through `kubectl oidc-login` needs a
binary called `kubectl-oidc_login`. A user had one, working, in their
terminal — and the app said it was not installed, listed the eighteen
directories it had searched, and advised `kubectl krew install
oidc-login`. krew is where the plugin already was.

PATH comes from a login shell, which on zsh reads `.zshenv`, `.zprofile`
and `.zlogin` and never `.zshrc` — and `.zshrc` is exactly where krew's
own instructions put its PATH export. `$KREW_ROOT/bin`, or `~/.krew/bin`,
is searched now regardless of what the shell said.

### Fixed — a port-forward that reconnected forever and would not say why

Two defects, one cause: the session could neither recover nor explain
itself.

It held the Kubernetes client it was created with. That client carries
the credentials it was built with and this app renews none — a GKE token
lasts about an hour — so every attempt failed after that, and kept
failing even once the cluster was reconnected, because reconnecting
replaces the app's client while the forward still held its own copy. Each
attempt asks for the current client now, so reconnecting heals the
forward.

The reason was discarded. `Retry in 10s` was the whole message, which
made an expired credential indistinguishable from a blip. It rides along
now. And a forward that cannot come back stops saying it will: a pod
replaced by a rollout ends immediately, naming what happened, and
anything else gives up after about two minutes as an error rather than a
banner that never resolves.

### Fixed — port-forward management nobody could find

There is a Ports tab, with every running forward, its address and its
state. Its only door was a status-bar line reading "1 active" — the
faintest role at eleven pixels, in a row of `dark · 239 pods · 8
problems` where nothing else is clickable, naming a category rather than
the thing anyone is looking for.

Three doors now. The command palette lists **Port forwards**, Terminals
and Background jobs — it is this app's answer to not finding something
and it did not know the panel existed, so it also learned to do things
rather than only go to them. The port-forward notifications carry a
**Manage** action, since the moment you are told a forward exists, or
that it is failing, is the moment you want it. And the status-bar line
names what is running when only one kind is: "1 port forward".

### Added — a pod whose node stopped reporting no longer reads healthy

A pod's status is written by the kubelet on its node. When the node stops
answering, nothing rewrites the pod: `Running` stays written until
eviction, which the default toleration puts five minutes out and which
never comes for a StatefulSet until the node object goes. Every client
draws that pod confidently green.

The label stays the one `kubectl` prints — it is the status the cluster
holds, and a second opinion invented here would be its own lie. The
colour drops to the app's "no opinion" role, and the tooltip names the
node and how long it has been quiet.

`Ready=False` is deliberately not silence. A node reporting NotReady is a
node still talking, so its pods' statuses are current; marking those
stale would light the mark on every ordinary unhealthy cluster, which is
how a warning stops being read.

## [4.2.0] - 2026-08-17

Three lines of work. The cluster's edge became a thing the app can see —
a `defaultBackend` Ingress used to read as touching nothing, and every
surface downstream of that mistake said "served in the clear" about an
edge that terminates TLS at Google. The peek learned to walk the traffic
path instead of dead-ending. And a day was spent on waits: fewer of them,
started earlier, and drawn honestly while they last.

### Added — the edge the cluster actually runs

An Ingress with no `rules` and only `spec.defaultBackend` is the
ordinary way a cloud load balancer fronts an in-cluster proxy — and the
app read it as an Ingress touching nothing: an empty connections graph,
an empty GKE page, and a "served in the clear" verdict about every host
behind it. The default backend is now an edge like any rule, on every
surface that reads one: the connections graph, the Ingress list, page
and peek, and the traffic chains.

Around it, the routing surfaces grew up: a routing map for every proxy
(hover highlights the path, the namespace filter narrows it), vendor
kinds open in the peek with the vendor's own reading of them, a
certificate's issuer is named the way a person would recognise it, and
the sidebar splits the cluster's own rows from the integrations'.

### Added — the peek walks the traffic path

A peeked Service, Endpoints, Pod or workload now draws its place in the
request path on the same dot-and-rail the detail pages use: the ways in
above it, the object itself haloed and tinted mid-chain, what answers
below. One dot per level — two routes to one Service are two doors on
one level, not a sequence — with the arrowheads running between levels,
red into a stop. Every name on the rail is a reference: glyph, hue, a
peek of its own, including the vendor's route objects, so the tangle
unwinds hop by hop without leaving the panel. A Pod's ways in reach past
its Service to the IngressRoute above it.

References themselves learned to carry their namespace inside the pill —
dim, truncating and highlighting with the name — instead of as a loose
prefix printed beside it.

### Fixed — "Sign in again" now works the first time

The credentials-expired screen's one button did its job — the reconnect
landed — and the banner stayed, because the refusal flag only cleared on
a context _change_ and the button reconnects to the same context. A
reconnect that lands now lifts it.

The same class of bug sat behind three more faces, all fixed: every
landing flushes the query cache, so answers collected while disconnected
("no cluster connected" probes, "client not found" lists) do not survive
onto a healthy session; a configured vendor's probe is never asked of a
disconnected app; and the integrations rail forgets the old cluster's
vendors the moment there is no cluster, instead of drawing them under
"no cluster" — the detection scan is now cached per cluster, as its
comment always claimed.

### Fixed — quantities a person can read

`268435456 → unlimited` in a pod's requests-and-limits is now
`256Mi → unlimited`. Whatever unit the author wrote, the peek says it
the way it is read.

### Changed — loading looks like what loads

The table skeleton borrows the real columns' declared widths, the
table's own density, and — where the list groups its rows — the group
captions' rhythm, so arriving data replaces the shape instead of
repainting the screen. The peek's skeleton took the same lesson:
grouped key/value runs under heading bars, uneven the way real values
are.

### Performance

- The Kubernetes client asks for gzip; a 104-pod list dropped from ~5s
  to ~1.2s, which is parity with `kubectl` on the same link.
- A connection landing warms what every session opens — pods,
  deployments, services, and now the overview, the most expensive query
  in the app and the landing page's own.
- The Helm list fetched every revision of every release whole, each one
  carrying the release's full gzipped chart, then threw all but the
  newest away. It now picks winners from metadata labels and fetches
  only those; the reported cluster's page halved, histories ten deep
  drop ninety percent of the transfer.
- Every command slower than 500ms names itself in the log, which is how
  the Helm one was caught and the next one will be.

## [4.1.0] - 2026-08-16

Two lines of work. One stops the app stating absences it never checked —
on a managed cluster it was calling every HTTPS site plaintext. The other
is a whole-project cleanup that removed about 5,000 lines the app never
ran.

### Fixed — every HTTPS site on a managed cluster read as "no TLS"

None of the three clouds keeps the certificate where the app looked.
AWS's Load Balancer Controller does not read `spec.tls` at all, Azure's
keeps it on the Application Gateway, and GKE's uses a
`ManagedCertificate`. Everything that answered "is this served over TLS"
read `spec.tls` and nothing else: the Ingress list column, the Ingress
page, the peek, the `http://` link offered to open a site with, and —
deepest — the traffic chain of every workload behind a cloud load
balancer.

Traefik and ingress-nginx made it worse by drawing the conclusion out
loud. The ordinary managed shape is a load balancer holding the
certificate and forwarding plaintext to `web:80`; read from `spec.tls`
that becomes a warning about encryption which is wrong on every host at
once, which is how a warning stops being read.

A wildcard was not recognised either. `*.example.com` alongside
`example.com` on one Secret is how people set this up once and forget
it; compared literally, every subdomain behind it came back bare.

Two new capabilities carry the answer instead: `ingress.tls` (does this
vendor terminate TLS for this host) and `service.routes` (which
hostnames reach this Service). `ingress.tls` takes a list and answers
positionally, because the Ingress list is a table and a per-row
capability could not have been used there — which is exactly where the
wrong answer cost the most. Where the vendor cannot know, it says so
rather than guessing: a `ManagedCertificate` that is not yet `Active`, a
pre-shared certificate, an ALB with no ARN written down all return no
opinion, and `spec.tls` keeps the last word.

### Added — four screens for the question a connection test cannot answer

GKE Ingress (host → what terminates it → what answers), the AWS Load
Balancer Controller (**one row per ALB, not per Ingress** — `group.name`
merges Ingresses across namespaces onto one listener, and no Ingress
page can show its neighbour), AKS add-ons, and Prometheus/Loki. The last
one answers _is this the right one_: the nodes it scrapes against the
nodes this cluster has.

Argo CD now names the objects it owns rather than counting them, and
cert-manager can say which address goes dark when a certificate expires
— the reference runs the other way round, so a row could report "Ready,
30 days left" and not what it served.

### Added — connecting an in-cluster Prometheus or Loki without a terminal

The connect dialog can find the Service and forward a local port to it.
Pinning the pod was rejected: `port_forward_pod` targets a pod by name
and reconnects to _that_ pod, so one rollout would leave a `localhost`
address that looks fine and answers nothing. The Service is what gets
stored, the pod is resolved again every time.

### Added — Diagnostics

A Settings section that opens with what is wrong in the environment and
holds the whole of it underneath: the directories a spawned binary is
looked for in, the tools and kubectl plugins that resolve on them, how
each context authenticates, and where the kubeconfig, config and logs
live.

It exists because a missing `kubectl-oidc_login` surfaced as kubectl's
own `unknown command "oidc-login" for "kubectl"` — a sentence that names
neither the file kubectl wanted nor where it looked. The underscore
spelling is not something a reader guesses.

One button copies the report for a chat message or an issue. It is
redacted by default: the home directory becomes `~` and context names
become `context-1`, consistently across every block so the findings
still point at rows the reader can find. The toggle beside it turns that
off.

### Fixed — a missing kubectl plugin is now named before the spawn

An exec block reading `command: kubectl, args: [oidc-login, …]` needs
`kubectl-oidc_login` on the path. The auth terminal used to relay
kubectl's refusal verbatim; the check now runs first, against the same
path the plugin would have been spawned with, and says which file is
missing and where it was sought.

Anything that is not a kubectl subcommand passes straight through:
refusing a whole binary because its name looked like a plugin would
break the commands that work today.

### Fixed — lists

- **Row action buttons did nothing.** One click was swallowed, several
  navigated instead. `flexRender` treats a cell renderer as a React
  element _type_, the renderer was rebuilt on every render, and the list
  re-reads itself every two seconds — so the button under the pointer
  was a different DOM node between `mousedown` and `mouseup`, and no
  click was ever raised.
- **A list of 105 pods drew a 600px table** and left the rest of the
  window blank, from a constant that never looked at the viewport. The
  pane is a ceiling now, not a target: a twelve-row list still ends
  where its rows end.
- **A failed read looked like an empty cluster.** Pages that fetch their
  own rows had no way to hand an error to `ResourceList`, so a 403 and
  an empty namespace arrived identical and the table said "no pods in
  the current scope" for both. A 403 was also retried three times, about
  seven seconds of skeleton per failing list per poll.
- The peek panel opens every object, custom resources included.

### Removed — a whole-project cleanup

Roughly 5,000 lines of source, none of which the app ran. The largest
pieces:

- **The plugin subsystem.** Its registry was empty — nothing implemented
  any of its three traits and `register_builtin_plugins` was a no-op —
  and what remained live merely forwarded to `cli::PluginDiscovery`.
- **Seventeen Tauri commands with no caller**, the four typed `*_yaml`
  wrappers among them, superseded by the generic `get_manifest` the
  frontend actually calls.
- **Three native auth providers** (`AwsEksAuth`, `BearerTokenAuth`,
  `KubeconfigAuth`) that only their own tests ever constructed. EKS is
  unaffected: it authenticates through the kubeconfig `exec` block, the
  way `kubectl` does. Their removal drops 56 crates from `Cargo.lock`.
- **`ErrorExt`.** An error reaches the frontend as its `Display` string
  and nothing else, so `error_code`, `details` and `is_retryable` were
  read by tests alone.
- **Twenty-five dependencies** — sixteen Rust crates, eight npm packages,
  and `@radix-ui/react-separator` with the component that used it.

### Fixed — five packages the code imported but never declared

`@radix-ui/react-collapsible` and four `@codemirror`/`@lezer` packages
resolved only through hoisting. The collapsible one was load-bearing:
its sole supplier was `@radix-ui/react-accordion`, which looks unused.

### Changed — the gates now cover the tree they claim to

`cargo fmt`, `cargo test` and `cargo clippy` were scoped to `src-tauri`,
so `k8s-gui-common` was never format-checked and its tests ran nowhere.
`.rustfmt.toml` carried seven nightly-only options that stable rustfmt
discards on every run. The frontend lint step is required again — the
warning backlog it was waived for is empty. Nothing runs on push any
more: the pre-push hook bought a slower push and no coverage, since CI
runs a strict superset of it.

## [4.0.1] - 2026-08-15

Nothing here changes what the app does. It is a dependency sweep — the
whole open queue, thirteen commits — kept as a patch release because a
minor would promise features this does not have.

### Changed — dependencies

Four of these needed migration rather than a version bump, and none of
the four builds from the bump alone:

- **Tailwind 3 → 4.** The PostCSS plugin moved to its own package, the
  `@tailwind` directives became an import, and theme config left JS.
  The official codemod handled most of it and got one thing wrong: it
  rewrote `outline` to `outline-solid` in four component _prop_ values,
  which are not CSS classes. No visual change — the cluster picker
  rendered from both builds differs by RMSE 0.0004 across the sidebar,
  which is anti-aliasing.
- **TypeScript 5.9 → 6.** It deprecated `baseUrl` and stopped pulling
  every `@types` package in automatically, without which `node:fs` in
  the tests stops resolving. Naming `types: ["node"]` fixes the second
  and makes the first unnecessary: `paths` were already relative.
  `baseUrl` and the `ignoreDeprecations` escape hatch are both gone
  rather than bumped, so 7.0 will not need a second visit.
- **js-yaml 4 → 5.** Dropped the default export and the iterator
  overload of `loadAll`. Five files moved to named imports. `tsc` did
  not catch the missing default — `esModuleInterop` types it fine and
  it fails only at runtime.
- **rand 0.8 → 0.10.** Two renames deep: `thread_rng` became `rng` in
  0.9, and 0.10 moved generation to free functions. The PKCE verifier
  fills a `[u8; 32]` through `rand::fill` now, on the same thread-local
  CSPRNG as before.

Merged as-is: `tokio-tungstenite` 0.24 → 0.30, `config` 0.14 → 0.15,
`dirs` 5 → 6, `jsdom` 29 → 30, `@testing-library/jest-dom` 6 → 7,
`actions/checkout` 7.0.1, `codeql-action` 4.37.6, and a group of 35
patch and minor updates.

### Fixed — CI

`codeql-action/init` and `.../analyze` are bumped as separate
dependencies, so updating one left the pair on different versions and
CodeQL refused them: _"Loaded a configuration file for version '4.37.6',
but running version '4.35.2'"_. They are pinned to one SHA now.

### Deferred

`k8s-openapi` and `azure_core` each have an open major that cannot move
alone — the first is pinned by `kube`, the second by `azure_identity`.
The Azure pair also has nothing to verify against without a live AKS
cluster, and an auth change shipped blind is the thing this project
declines to do.

## [4.0.0] - 2026-08-15

Not a line of code changed in this release. The major version is here
because the terms did, and a major is the only version signal people
reliably read.

### Changed — the licence is now GPLv3

Rubick was MIT through 3.1.0 and is GPL-3.0-or-later from here on, agreed by
both copyright holders.

A permissive licence allows a closed, rebranded fork of this work to be sold
without its source. That is the outcome the project exists in reaction to,
so the door is now shut: a modified version may still be forked and still be
sold, but whoever distributes it ships the source under the same terms.

Nothing changes for anyone running the app, including inside a company on
any number of machines — use is not distribution and triggers no obligation.

Releases up to 3.1.0 stay MIT; that grant cannot be withdrawn.
[LICENSE-HISTORY.md](LICENSE-HISTORY.md) keeps the record.

## [3.1.0] - 2026-08-13

### Fixed — an expired session claimed the cluster was empty

GKE tokens last about an hour and nothing here renews them. A list that
came back 401 used to render its **empty** state, so an expired session
told the reader, on every screen at once, that their cluster had no pods
in it — the one failure mode that looks exactly like a working app
reporting bad news.

A 401 is now its own error rather than an absent result. `ResourceList`
reads its query error, and a refused session replaces the page with a
screen that names the cluster, quotes the API server, and offers a way
back in.

### Added — cert-manager page

The Integrations category listed vendors that declared a `page` and
silently dropped the rest, so cert-manager was detected on plenty of
clusters and appeared nowhere. The category now lists every detected
extension; the ones that own no screen go to their Settings row.

The page walks Certificate → CertificateRequest → Order → Challenge and
prints the sentence from whichever object actually failed.

### Added — Traefik routing map

Entry point → host → service, layered and deterministic, ordered by
trouble like every other list here. `page-kit` now draws the joins
between its columns, so the chain a single request travels stays a
chain and all five vendor pages read as one path rather than five
stacks of boxes.

A workload's traffic chain reaches the controller, the certificate, a
copyable URL, and the address the hostname has to resolve to — all from
reads the app already made.

### Changed — namespaces are a selection, not a value

Lists are read once cluster-wide and narrowed on the client; aggregates
are asked per namespace and joined, which is what `SCOPE_LIMIT` bounds.

What gets persisted stays a single namespace, deliberately: an older
build reading the new setting sees "all namespaces" rather than one that
does not exist.

### Changed — tables stopped moving

`table-fixed` with widths as shares of the table, hover moved out of
React state and into CSS, real virtualisation, and no pagination — a
live list has no stable page two.

Row actions came and went during this work: they duplicated the delete
already on the row, behind a weaker confirmation.

### Performance

- **Watch events batch on the log streamer's 50 ms flush.** A
  1000-object burst is 5 events and one render instead of 1000 and 1000.
- **`count_of` reads one page** and trusts the apiserver's
  `remainingItemCount` instead of pulling every Event's metadata every
  ten seconds.
- **Workload metrics are pre-indexed.** 200 deployments against 2000
  pods went from 15.9 ms to 1.4 ms.
- The frontend event bridge no longer dies permanently on a lagged
  broadcast, and tells the window when it drops something.

### Caught in review

A second, adversarial pass found the two worst things in the branch,
both fixed before merge:

- `table-fixed` resolves `width: 100%` as max(100%, sum of widths), so a
  Pods list came out 378 px wider than the default window with its
  actions off-screen.
- The overview merge drew every cluster-scoped problem once per selected
  namespace.

### Tooling

Tests: 337 → 344 cargo (plus 10 ignored), 1437 → 1577 vitest across 123
files.

## [3.0.1] - 2026-08-11

### Fixed — macOS refused to open the downloaded app

A Mac that downloaded 3.0.0 from the releases page reported
**"«Rubick» is damaged and can't be opened"** and offered only to move it
to the Trash. The download was not corrupt: the bundle carried nothing
but the linker's ad-hoc signature (`Signature=adhoc`,
`TeamIdentifier=not set`, `Sealed Resources=none`), and Gatekeeper
answers a quarantined ad-hoc bundle with "damaged" rather than the
familiar unidentified-developer prompt. Every release since the 2.0.0
open-source launch had this; it was not new in 3.0.0 and not caused by
the rename.

macOS builds are now signed with a Developer ID Application certificate
and notarised by Apple, so they open on a clean machine with no warning
and no terminal incantation.

Notarisation authenticates with an App Store Connect API key rather than
an Apple ID and app-specific password: no interactive account, nothing to
re-enter when 2FA rotates.

The `TAURI_SIGNING_PRIVATE_KEY` this project already had is unrelated —
it is the minisign key that proves an _update payload_ came from us, and
Gatekeeper never sees it. Both signatures are needed, for different
things.

**Already have 3.0.0 installed?** The in-app updater was never affected;
it verifies the minisign signature and installs normally. This release
only changes what happens when a browser downloads the app for the first
time.

## [3.0.0] - 2026-08-11

One rule decided most of this release: **the app must not claim what it
cannot back.** It is why a pod that displayed `Running` while its
container was dead counted as a bug rather than a cosmetic issue, why an
integration reports which stones it left unturned, and why a chart with
no history says so instead of drawing an empty plot.

### Renamed — K8s GUI is now Rubick

The repository had been renamed and the product had not, so every window
title, bundle name and doc comment still said K8s GUI. The product now
answers to Rubick, and the repository moved to
[`Dudude-bit/rubick`](https://github.com/Dudude-bit/rubick).

Two things are deliberately unchanged:

- **The bundle identifier stays `com.k8s-gui.app`.** Changing it orphans
  every installed copy from its updater and leaves a second app sitting
  beside the first. Existing 2.x installs therefore take this release as
  an ordinary in-place update; the app's name on disk and in the menu bar
  changes, the install does not fork.
- **The crate and binary names stay `k8s-gui` / `k8s_gui_lib`**, because
  the release workflow's artifact paths are keyed to them.

The updater endpoint now points at the renamed repository. Binaries built
before the rename keep asking the old URL, which GitHub redirects, so
2.1.0 installs still find this release.

### Added — integrations platform

A vendor tree where a new integration costs one folder and one line,
with a lint rule holding the seam: nothing outside `src/integrations/`
may name a vendor, and every surface asks for a _facet_
(`useCapability`, `useCrdView`, `flavourOf`) rather than for
cert-manager. The drift that made this necessary was cert-manager
landing twice, in two systems, because nothing refused the second one.

Three tiers carry different obligations: core, in-cluster extensions
detected by CRD, and external services configured by URL. Shipped:
cert-manager, Traefik, ingress-nginx, Istio, Argo CD, Flux, Prometheus,
Loki, k3s, minikube, Karpenter, and the three clouds' own controller
CRDs (AWS, Azure, Google Cloud).

cert-manager surfaces certificate expiry everywhere TLS is named, plus
the four-object issuance chain that ends on the sentence saying what
actually failed.

### Added — connections

One command answers an object's whole neighbourhood from the six edges
Kubernetes states outright (`commands/connections.rs`,
`resources/connections.rs`, `resources/selector.rs`).

The traffic chain draws the path from Ingress to pods and, more usefully,
**names where it stops**: a backend that does not exist, a selector that
matches nothing, and pods that are running but not ready — which every
list page in every tool draws as healthy. EndpointSlices replaced the
readiness deduction, which is what caught the named-port mismatch: a
Service with healthy pods, a healthy selector, and no traffic at all.

### Added — governance and delivery awareness

HPA and PodDisruptionBudget are read and rendered as three rows on the
workload they qualify (`Set by`, `Now`, `A drain waits`) rather than as
blocks of their own.

Scale, Restart, Delete and Edit YAML each say who will undo the change
and how fast — an autoscaler in about fifteen seconds, a GitOps
controller in about three minutes, both if both. They tell rather than
block: scaling a managed object by hand during an incident is
legitimate, and the app has no business refusing it. Every object's page
says whether GitOps delivers it and whether your edit will survive.

### Added — usage over time

CPU and memory as a series: the window the app watched itself when only
metrics-server is present, real ranges when Prometheus is connected, and
disk fullness and traffic that `metrics.k8s.io` cannot answer at all.

### Added — search, overview, ReplicaSets

A planned cluster-wide search (`search/plan.rs`), a cluster overview
command, and ReplicaSet as a first-class resource with its own detail
page.

### Fixed — status that tells the truth

`resources/types/pod_display.rs` ports kubectl's `printPod`, so the app
stops showing `Running` for a crash-looping pod. Init containers reach
the frontend as an ordered sequence; sidecars are distinguished from
init containers by the kubelet's own judgement instead of being
re-derived. Readiness counts sidecars exactly as `kubectl get pod` does,
verified against all 16 pods of a live cluster.

### Changed — logs and shell

The log viewer opens where the answer is: on a pod stuck in
`Init:CrashLoopBackOff` it opens on the failing init container, on its
previous run, and says so. Adds server-side intake filtering, a density
strip, repeat collapsing, and multi-container interleave.

Shell became a full-height tab whose session survives tab switches. The
fix uncovered that pod shells had been accepting no keyboard input at
all.

### Changed — design system

One flat canvas built on role tokens, calibrated by measurement rather
than opinion, with identity colouring by kind and by identifier chosen
to survive greyscale and colour blindness.

Three lint guards keep it from drifting back, all in the single
`no-restricted-syntax` block in `eslint.config.js`:

- Raw Tailwind colours, `dark:` branches, and the legacy shadcn tokens
  the app was scaffolded with are refused across all of `src/`. The
  shadcn names still resolve, which is why they survived so long:
  nothing breaks, the component just quietly leaves the design system.
- `refetchInterval` is an error everywhere except `useLiveQuery.ts`.
- Importing a named vendor from outside `src/integrations/` is refused.

### Performance

**Idle load on the API server: 895 → 205 requests per minute (−77%.)**

What cost that traffic was 45 hand-written polling intervals, of which
two checked whether anybody was looking at the screen they belonged to.
`useLiveQuery` now takes a _rate_ rather than a number and derives the
interval from visibility, window focus, stillness, and whether a watch
is live — and a lint rule stops the number from being written by hand
again.

A fourth freshness state, `slowed`, exists so that backing off never
lets stale data sit under a live badge. Every way of arriving back at a
query refetches it first: switching to a detail tab, un-minimising,
regaining focus. The licence to stop polling rests on that.

### Tooling

- **npm → bun.** `bun.lock` is committed; `beforeDevCommand` and
  `beforeBuildCommand` run through bun. CI installs and builds with it.
- Tests: 129 → 337 cargo (plus 10 ignored), 100 → 1437 vitest across
  112 files.
- `tsc`, `eslint --max-warnings 0`, `cargo fmt --check` and both test
  suites were green at every one of the 231 commits on the branch.

### Deliberately not done

- **Cloud tier 3** (pool ceilings, load-balancer health, workload
  identity) needs a real GKE/EKS/AKS cluster to verify against.
  Building it blind means shipping fields we never saw an API return.
- **Cost estimation.** Committed use, sustained use, spot pricing and
  negotiated rates make it wrong more often than right, and a wrong
  number about money poisons the right ones.
- **A whole-cluster topology graph.** The routing layer is a chain in
  fixed order, not a general graph; a force-directed blob looks like
  insight and answers nothing.
- **Editing routes, renewing certificates.** Reading these well is a
  feature; writing them is a different one with a different blast
  radius. An ACME rate limit is five failures per hour, and a button
  that burns them takes the cluster down at the worst moment.

## [2.1.0] - 2026-04-28

### Fixed — interactive auth (OIDC, kubelogin, exec plugins)

The "Authentication Required" modal could appear blank when a kubeconfig
context required interactive credentials. Three independent root causes
were closed end-to-end:

- **Race between backend I/O loop and frontend listener.** Terminal
  sessions used to start emitting bytes the moment the adapter
  connected — but the React `listen("terminal-output")` callback
  was still mid-`await`. Tauri events have no replay, so the first
  prompt landed in the void. Backend now blocks on a deferred-start
  oneshot gate; the frontend hook releases it via the new
  `terminal_subscribed` Tauri command only after both `listen()`
  calls have resolved. 60 s safety timeout if the frontend never
  signals.
- **`AuthExecAdapter` swallowed stdout.** Many OIDC tools
  (`kubelogin --grant-type=authcode-keyboard`, some
  `kubectl-oidc_login` variants) print the "open this URL" prompt
  to stdout. The adapter previously dropped stdout (only stderr
  reached the terminal). Now stdout is tee'd into both the JSON
  collector and the terminal stream.
- **Pipes instead of a real PTY.** Tools that call
  `term.ReadPassword` / `getpass` check `isatty(stdin)` and refuse
  to prompt without a TTY. Replaced pipes with a real PTY pair via
  `portable-pty 0.9` (cross-platform: ConPTY on Windows, openpty
  on Unix). `resize` now actually issues `TIOCSWINSZ`.

The same deferred-start handshake also applies to `PodTerminal`
via the shared `useGenericTerminalSession` hook.

### Fixed — log viewer

- **Same listener-race as terminal-auth** applied to
  `stream_pod_logs`. The streamer task now blocks on a
  `log_stream_subscribed` gate.
- **Stable React keys.** `LogViewer` keyed on filtered-array index,
  so changing the search query unmounted unrelated rows. Each log
  line now carries a synthetic monotonic id assigned at receive time.
- **RAII cleanup guard** for the spawned log-stream task. Panic in
  `streamer.stream_logs()` (or any other unwind path) used to leave
  a zombie entry in `state.log_streams`; the entry is now removed
  by a Drop guard on every exit.

### Fixed — port-forward

Same RAII cleanup guard pattern applied to the port-forward listener
spawn. A panic in `listener.accept()` no longer leaves orphaned
entries in `state.port_forward_sessions` /
`state.port_forward_controls`.

### Performance

- **K8s watch instead of 2-second polling.** A new `WatchManager`
  owns `kube::runtime::watcher` streams keyed by `(cluster, kind,
namespace)`. Events are forwarded to the frontend over a
  `resource-event` Tauri broadcast and applied to the TanStack
  Query cache via `setQueryData` — no refetch round-trip.
  **All 16 list pages migrated** (ConfigMap, Secret, Service,
  Endpoints, Ingress, PersistentVolumeClaim, Pod, Deployment,
  StatefulSet, DaemonSet, Job, CronJob, Node, PersistentVolume,
  StorageClass, CustomResource).
- **Watch failure detection + automatic polling fallback.** If the
  kubeconfig user lacks the `watch` verb (or kube-apiserver is
  unreachable), the backend emits a `Failed` event after three
  consecutive errors. The frontend toasts «Real-time updates
  unavailable: <kind>: falling back to periodic refresh» and
  re-enables the underlying `useQuery`'s `refetchInterval`. When
  the watcher recovers, the page auto-flips back to pure-watch
  mode.
- **Initial JS bundle 408 KB → 197 KB gzip (-52%).** CodeMirror
  (`YamlEditor`) and xterm (`Terminal`) are now lazy-loaded behind
  `React.lazy`; their chunks fetch only when a screen mounts them.
- **Log-stream events now batched** (50 ms tick or 100 lines,
  whichever first). Renamed Tauri event `log-line` → `log-batch`;
  payload carries `Vec<LogLineEvent>`. Verbose pods (100+ lines/sec)
  generate ~5× fewer Tauri round-trips.

### Security

- `AuthResult` no longer derives `Debug` — manual impl emits
  `<redacted>` for `token` and `refresh_token`. Defense-in-depth
  against future code that might log the struct.
- `K8sClientManager::load_kubeconfig_from_path` canonicalizes the
  path (resolves `~`, `..`, symlinks) before opening the file.
  Returns a clear `AuthError::Kubeconfig` on a missing target.
- New `.github/workflows/codeql.yml` runs CodeQL JavaScript /
  TypeScript analysis with `security-extended` queries on every
  push/PR plus a weekly Monday cron.

### Refactors / hygiene

- `WatchManager`, `LogStream`, `PortForwardSession` cleanup all
  follow the same RAII Drop-guard pattern. Adding a new long-lived
  background task is now a one-line `let _cleanup = …;` at the top
  of the spawn.
- `eslint` count: **59 → 0**. The pre-existing 59 warnings from
  the react-hooks 4 → 7 upgrade (set-state-in-effect,
  preserve-caught-error, only-export-components, etc.) are all
  closed: real refactors where derivable, documented disables with
  rationale where genuinely event-driven, mechanical
  `{ cause: err }` for caught-error preservation. Lefthook enforces
  zero-lint going forward.
- `tsconfig` target bumped ES2020 → ES2022 (needed for
  `Error(message, { cause })`). Vite's emit target is already
  safari15 / chrome110, so runtime support matches.
- Tests: 113 → 129 cargo (+16), 70 → 100 vitest (+30), including
  characterization tests for `AuthTerminal`, end-to-end handshake
  tests for every deferred-start gate, and cache-mutation tests
  for `useResourceWatch`.

### Adding a new K8s resource watch (5-step recipe for contributors)

1. Ensure `KindInfo` has `From<&K8sType>` (most do).
2. One `subscribe_namespaced!` or `subscribe_cluster!` macro line
   in `commands/watch.rs`.
3. One `commands::watch::subscribe_<kind>_watch` line in `main.rs`'s
   invoke handler.
4. One `subscribe<Kind>Watch(...)` binding in
   `src/generated/commands.ts`.
5. One `watch:` field on the page's `createResourceListPage` /
   `createWorkloadListPage` config (or call `useResourceWatch`
   directly for hand-rolled pages).

### Known issues (deferred to a future minor)

- Five long files (`InfrastructureBuilder.tsx` 1222 LOC, `Helm.tsx`
  1037, `InspectorPanel.tsx` 1015, `PodDetail.tsx` 833,
  `src-tauri/src/logs/mod.rs` 910) are still single-file monoliths.
  Each is its own focused refactor with TDD safety net.
- Pod / Node metrics still poll. Metrics k8s API has a different
  shape than the typed list APIs — separate migration.

## [2.0.1] - 2026-04-25

### Fixed

- `rules-of-hooks` violations in `StatefulSetDetail`, `DaemonSetDetail`,
  and `JobDetail`: a conditional early-return ran before `useMemo`,
  shifting hook order between renders. Hook now runs first.
- `NodeDetail` rebuilt the page icon component inside a JSX IIFE on every
  render. Hoisted to module scope.
- `InspectorPanel` form-init effect was flagged by the stricter
  `react-hooks/exhaustive-deps` after the React 19 / react-hooks 7
  upgrade. The narrow dep list (`[node?.id]`) is intentional —
  documented inline so future readers see the design.

### Security

- Replaced `"csp": null` in `tauri.conf.json` with a restrictive
  Content-Security-Policy. Limits what a malicious K8s server response
  could execute inside the WebView.

### CI / Tooling

- New `.github/workflows/ci.yml` — fast lint + test job on every
  push/PR (cargo fmt, cargo clippy informational, cargo test, tsc
  noEmit, npm run lint informational).
- `.npmrc` pins `include=optional` so platform-specific native
  bindings stay in `package-lock.json` regardless of where the
  lockfile was regenerated.
- Removed `Dockerfile.linux-build` (long-dead, replaced by GitHub
  Actions Linux build).
- Applied `cargo fmt` across `src-tauri/` (one-time cleanup on
  rust 1.95).

### Known issues (deferred to 2.1)

- `tokio::spawn` calls in `commands/logs.rs` and
  `commands/port_forward.rs` don't track JoinHandles — task panics
  leave entries in state maps. Architectural fix planned.
- `npm run lint` surfaces ~49 errors after the
  eslint-plugin-react-hooks 4 → 7 upgrade. Most are stylistic
  (set-state-in-effect, preserve-caught-error); none are runtime
  bugs. Triage planned.
- See `docs/superpowers/specs/2026-04-24-post-v2-audit-findings.md`
  for the full roadmap.

## [2.0.0] - 2026-04-24

### Added

- Initial open-source release under MIT license.

### Removed

- Proprietary licensing and premium feature gating.
