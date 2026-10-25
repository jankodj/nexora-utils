# KP AI Cloud Monitor – clean public repository edition v2.8

Ovaj paket sadrži SAMO kod, bez tokena. GitHub Actions (standardni `ubuntu-latest`) besplatan je u javnim repozitorijumima prema trenutnim GitHub pravilima. Ovo ne garantuje neprekidno izvršavanje: `schedule` može kasniti, preskakati zadatke, a u neaktivnom javnom repozitorijumu može se automatski isključiti posle 60 dana. Proveri i uslove korišćenja KP-a i GitHub-a.

## Bezbedan prelazak

**Nemoj prebacivati stari privatni repozitorijum na Public:** njegova istorija možda sadrži osetljive podatke. Napravi NOVI javni repozitorijum, npr. `kp-ai-monitor-public`, i dodaj samo fajlove iz ovog ZIP-a. Nemoj kopirati `.git` direktorijum iz starog repozitorijuma.

Fajlovi:
- `.github/workflows/kp-monitor.yml`
- `scripts/monitor.mjs`
- `package.json`
- `README.md`

U novom repozitorijumu otvori Settings → Secrets and variables → Actions → New repository secret i dodaj:
- `WORKER_URL` = tvoja postojeća `https://...workers.dev` adresa
- `INGEST_TOKEN` = isti token koji Cloudflare očekuje (vrednost NE zapisuj u kod)

U **Settings → Actions → General** postavi workflow permissions na **Read repository contents permission**. Ne dodaj `pull_request` ili `pull_request_target` događaje i ne odobravaj nepoznate izmene workflow-a bez provere. Public repo otkriva kod, ali ne i GitHub Actions secrets; korisnici ipak mogu pregledati kod i slati pull requestove.

Pokreni Actions → KP AI cloud monitor → Run workflow i proveri logove `listing`, `worker_response`, `summary`.

Kada sve radi, u STAROM privatnom repozitorijumu isključi zakazani `kp-monitor.yml` (ukloni `schedule` ili deaktiviraj workflow) da ne pokrećeš duple provere i ne trošiš privatnu kvotu.

## Raspored

`cron: '2/5 * * * *'` traži pokretanje na svakih pet minuta. Unutar jednog izvršavanja skripta proverava sve 3 KP pretrage, prve dve strane, dvaput, sa pauzom od 60 sekundi između krugova. **Ovo nije garantovan interval od 60 sekundi**. Različita izvršavanja ne rade istovremeno. AI se poziva tek kada Cloudflare primi novi oglas koji prođe prethodni filter; obrada pojedinih oglasa i dalje zavisi od trenutnog koda Workera.

## Ograničenja

- KP može promeniti HTML, isključiti pristup ili ograničiti automatizaciju.
- GitHub `schedule` može kasniti ili preskakati pokretanja; javni repo bez aktivnosti 60 dana može izgubiti zakazivanje.
- GitHub može primeniti ograničenja prihvatljive upotrebe na dugotrajne automatizacije čak i u public repo-u.
- Besplatni Gemini API ima kvote i nije garancija neograničenog rada.
- Pravila za procenu rizika i isplativosti nalaze se u postojećem Cloudflare Worker-u, ne u GitHub fajlu.
- Ni jedan novi `INGEST_TOKEN` nije generisan u ovom paketu.
