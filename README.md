# Whiteboard

Varje elev får en egen whiteboard i webbläsaren. Läraren ser alla tavlor live, kan visa en av dem
på projektorn och spara allas tavlor som en pdf. Sidan är helt statisk och kan hostas på GitHub Pages.

Ritningarna skickas direkt från elevens webbläsare till lärarens dator med WebRTC (PeerJS).
Det finns ingen egen server: PeerJS:s publika server används bara för att webbläsarna ska hitta varandra,
inga ritningar passerar den. Lärarens dator är "servern", så den måste ha sidan öppen under lektionen.

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
6. **Ny uppgift** rensar alla elevers tavlor. **Nytt rum** ger en ny kod och kopplar bort alla.

Rumskoden sparas i lärarens webbläsare, så om läraren laddar om sidan behåller rummet samma kod
och eleverna återansluter automatiskt och skickar om sina tavlor. Elevernas ritningar sparas lokalt i deras
webbläsare per rum, så en omladdning hos eleven tappar inte heller något. Varje flik räknas som en egen tavla.

## Hosta på GitHub Pages

Repot behöver ingen byggprocess. Slå på GitHub Pages för grenen `main` under *Settings → Pages*,
så finns sidan på `https://<användare>.github.io/whiteboard/`. Elevlänken blir då
`https://<användare>.github.io/whiteboard/elev.html#KOD`.

WebRTC kräver https (eller `localhost`), vilket GitHub Pages ger.

## Om skolans nätverk strular

Direktkopplingen mellan datorerna fungerar normalt på samma wifi. Blockerar nätverket den publika
PeerJS-servern (`0.peerjs.com`) kan du köra en egen [PeerServer](https://github.com/peers/peerjs-server)
och peka ut den genom att lägga in detta före `board.js` i både `index.html` och `elev.html`:

```html
<script>window.WB_PEER_OPTIONS = { host: 'din-server.exempel.se', port: 443, path: '/' };</script>
```

## Personuppgifter

Namnet eleven skriver in och det eleven ritar skickas bara till lärarens dator, aldrig till någon server.
Namnet sparas i elevens egen webbläsare för att slippa skrivas igen. Inget sparas hos läraren utöver det
läraren själv väljer att ladda ner.

## Bibliotek

- [PeerJS](https://peerjs.com/) (MIT), `vendor/peerjs.min.js`
- [pdf-lib](https://pdf-lib.js.org/) (MIT), `vendor/pdf-lib.min.js`
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), `vendor/qrcode.js`
