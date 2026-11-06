# Whiteboard

Varje elev får en egen whiteboard i webbläsaren. Läraren ser alla tavlor live, kan visa en av dem
på projektorn och spara allas tavlor som en pdf. Själva sidan är statisk och ligger på GitHub Pages.

Strecken går via en liten reläserver som körs som en Cloudflare Worker. Den sparar varje elevs tavla
i upp till en vecka och skickar strecken vidare till läraren, allt över vanlig https (WebSocket), så den
fungerar även på skolnät som blockerar annan trafik. Cloudflares gratisnivå räcker gott för en skola.

## Så här används den

1. Läraren öppnar `index.html`. En rumskod och en QR-kod visas.
2. Eleverna går till `elev.html` (länken och QR-koden på lärarens sida leder dit med koden ifylld),
   skriver sitt namn och trycker **Gå med**.
3. Eleverna ritar med penna, finger eller mus. Verktyg: fem färger, tre tjocklekar, sudd, ångra (Ctrl+Z)
   och rensa. Med **Bara penna** ikryssat ignoreras fingrar, så handflatan inte ritar. Rutan kryssas i
   automatiskt första gången en penna används.
4. Läraren ser alla tavlor i ett rutnät. Klicka på en tavla för att visa den stort, bläddra med
   piltangenterna, **F** för fullskärm och **Esc** för att stänga. Visningen uppdateras live.
5. **Spara alla som pdf** ger en pdf med en tavla per sida (A4 liggande) med elevens namn.
   Knappen **png** på en tavla sparar bara den tavlan.
6. **Ny uppgift** rensar alla elevers tavlor. **Nytt rum** ger en ny kod.

Rumskoden och en hemlig nyckel sparas i lärarens webbläsare. Bara den webbläsare som öppnade rummet kan
se tavlorna, och en omladdning hämtar hela rummet från servern igen. Elevernas streck sparas också lokalt
i deras webbläsare, så en omladdning hos eleven tappar inget. Varje flik räknas som en egen tavla.

## Installation

### 1. Sidan på GitHub Pages

Slå på GitHub Pages för grenen `main` under *Settings → Pages*. Sidan hamnar på
`https://<användare>.github.io/whiteboard/`.

### 2. Reläservern på Cloudflare

Reläet ligger i mappen `relay/` och publiceras som en Worker på ett (gratis) Cloudflare-konto.
Välj ett av två sätt.

**Från Cloudflares webbsida, utan att installera något:**

1. Logga in på [dash.cloudflare.com](https://dash.cloudflare.com), gå till *Compute (Workers)* och välj
   *Create → Import a repository* (anslut GitHub om du inte gjort det och välj repot `whiteboard`).
2. Ange **Root directory** `relay`, lämna byggkommandot tomt och sätt **Deploy command** till
   `npx wrangler deploy`. Projektnamnet kan vara `whiteboard-relay`.
3. När första publiceringen är klar visas adressen, till exempel
   `https://whiteboard-relay.<ditt-konto>.workers.dev`. Varje push till `main` publicerar reläet igen.

**Från terminalen:**

```bash
cd relay
npm install
npx wrangler login
npx wrangler deploy
```

Sista kommandot skriver ut adressen till reläet.

### 3. Peka sidan mot reläet

Öppna `config.js` och byt platshållaren mot reläets adress:

```js
window.WB_RELAY_URL = window.WB_RELAY_URL || 'https://whiteboard-relay.ditt-konto.workers.dev';
```

Det går bra att göra direkt på GitHub: öppna filen, klicka på pennan, ändra, och spara (commit).
Vänta någon minut och ladda om lärarsidan hårt (Ctrl+Shift+R). Status ska då bli "Redo, väntar på elever".

Du kan kontrollera att reläet svarar genom att öppna reläadressen i webbläsaren: den ska visa
`{"name":"whiteboard-relay","ok":true}`.

## Personuppgifter

Det eleven skriver som namn och ritar skickas via reläservern till läraren och sparas där i upp till en
vecka efter att rummet senast användes, därefter raderas det automatiskt. Reläet körs på ditt eget
Cloudflare-konto och inga andra kan läsa rummet utan lärarens nyckel. Be eleverna skriva förnamn eller
smeknamn. Namnet sparas också i elevens egen webbläsare för att slippa skrivas igen.

## Bibliotek

- [pdf-lib](https://pdf-lib.js.org/) (MIT), `vendor/pdf-lib.min.js`
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), `vendor/qrcode.js`
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) (Apache 2.0) för att publicera reläet

## Vid uppdatering

Skript- och stilfilerna laddas med en versionsparameter (`?v=…`) i `index.html` och `elev.html`.
Höj den i båda filerna när du ändrar någon js- eller css-fil, annars kan webbläsare blanda gamla och nya
filer från cachen och sidan slutar fungera tills cachen går ut.
