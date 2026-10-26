# Storder – Foto rein, Kiste raus

Selfhosted Lagerkatalog für zuhause: Du machst mit dem Handy ein Foto von einem
Gegenstand. Ein LLM (z. B. über **OpenRouter**) erkennt das Produkt und sucht
Beschreibung, Maße und Gewicht – im Internet, wenn ein Websuche-Plugin aktiv ist.
Storder berechnet daraus das benötigte Volumen und sucht deterministisch einen
freien Platz in deinen Kisten. Jeder Gegenstand wird mit Zeitstempel
katalogisiert, ist durchsuchbar und kommt nach einem einstellbaren Zeitraum
zufällig zur Prüfung zurück („nutzt du das noch?“).

Später lässt sich alles pflegen: Beschreibung ändern, **Stückzahlen** und
weitere Fotos ergänzen, Kaufdatum und Kaufpreis eintragen, die **Originalrechnung
aus Paperless-ngx im lokalen Netz** verknüpfen (oder als Datei hochladen) und
**Kisten mit einem Foto von außen** versehen.

Beim Einlagern prüft Storder kurz, ob es den Artikel (oder einen ähnlichen) schon
gibt, und schlägt dessen Kiste vor – z. B. „Xbox Controller“ für „Xbox Zubehör“.

Für **Stapel-Erfassung** gibt es den **Posteingang**: Foto machen → „In den
Posteingang (schnell)" → nächstes Foto. Die Artikel liegen dann ohne Kiste im
Posteingang und werden später am PC oder Handy in Ruhe durchgesehen, ergänzt und
automatisch oder manuell eingelagert. Alle Bilder werden auf **max. 1000 px**
verkleinert und als **WebP** gespeichert.

```
Handy-Foto ─► LLM (Vision)  ─┐
              LLM (Websuche) ─┴─► Beschreibung + Maße + Gewicht
                                        │
                              Volumen (Geometrie, kein LLM)
                                        │
                              Platzsuche in Kisten (3D-Packing)
                                        │
                              Vorschlag: Kiste A23, Position, Füllstand
                                        │
                              speichern + durchsuchbar + Prüf-Erinnerung
```

**Wichtig:** Die KI schätzt *keinen* Platz. Sie liefert nur Produktdaten.
Volumen, Passung und Position rechnet Storder selbst – nachvollziehbar und
reproduzierbar.

---

## Schnellstart mit Docker (empfohlen)

```bash
cp .env.example .env
# In .env den OpenRouter-Key eintragen: OPENROUTER_API_KEY=sk-or-...
docker compose up -d
```

Danach im Heimnetz öffnen: **http://\<IP-des-Servers\>:8080** (die IP wird beim
Start auch im Log angezeigt). Am Handy am besten als Lesezeichen / „Zum
Startbildschirm hinzufügen“ ablegen.

Daten (SQLite-Datenbank + Fotos) liegen im Volume `storder-data` und überleben
Updates. Ein **Bind-Mount** statt Named Volume funktioniert auch, der Ordner
muss dann aber für UID 1000 beschreibbar sein (`sudo chown -R 1000:1000 ./data`),
weil der Container als unprivilegierter `node`-User läuft.

```bash
docker compose pull && docker compose up -d --build   # aktualisieren
docker compose logs -f                                 # Logs
docker compose down                                    # stoppen (Daten bleiben)
```

### Ohne Docker

Voraussetzung: Node.js ≥ 22 (empfohlen 24, da `node:sqlite` mitgeliefert wird).

```bash
npm install
cp .env.example .env    # Key eintragen
npm start               # http://localhost:8080
```

---

## Konfiguration

Alles über Umgebungsvariablen (siehe `.env.example`). Die wichtigsten:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | – | API-Key für OpenRouter (oder `LLM_API_KEY` für andere Anbieter) |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | jeder OpenAI-kompatible Endpunkt |
| `LLM_VISION_MODEL` | `google/gemini-2.5-flash` | Modell für die Bilderkennung |
| `LLM_WEB_MODEL` | `google/gemini-2.5-flash` | Modell für die Internet-Recherche |
| `LLM_WEB_SEARCH` | `true` | OpenRouter-Websuche-Plugin nutzen |
| `RECALL_INTERVAL_DAYS` | `30` | nach wie vielen Tagen Sachen zur Prüfung kommen |
| `RECALL_ITEMS_PER_RECALL` | `3` | wie viele Gegenstände pro Prüfung |
| `RECALL_MIN_ITEM_AGE_DAYS` | `14` | Mindestalter, bevor etwas geprüft wird |
| `PAPERLESS_URL` | – | z. B. `http://192.168.1.50:8000` (Paperless im LAN) |
| `PAPERLESS_TOKEN` | – | API-Token (Alternative zu Benutzername/Passwort) |
| `PAPERLESS_USERNAME` / `PAPERLESS_PASSWORD` | – | Login; Storder holt den Token selbst |
| `PAPERLESS_RESULTS` | `8` | Treffer pro Suche |
| `RECALL_ENABLED` | `true` | Prüf-Erinnerung an/aus |
| `SEED_BOXES` | `true` | beim ersten Start 6 Beispielkisten anlegen |
| `DATA_DIR` | `./data` (Docker: `/data`) | Datenbank + Fotos |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP-Port und Bind-Adresse |
| `LLM_MAX_IMAGE_DIM` | `1000` | max. Bildkante in px (Speicherung als WebP) |
| `TZ` | `Europe/Berlin` | Zeitzone für Datumsanzeigen |

Modell und Erinnerungs-Intervall lassen sich zusätzlich **in der App** unter
⚙ ändern (wird in der Datenbank gespeichert, hat Vorrang vor den ENV-Defaults).
Der API-Key wird nie in der App angezeigt oder gespeichert – nur aus der
Umgebung gelesen.

---

## Bedienung

1. **Einlagern** – der Bildschirm ist von oben nach unten aufgebaut:
   **1) Hinweis** (optional, z. B. „Toaster"), **2) Automatisch analysieren**
   (Häkchen, standardmäßig an), **3) Foto** – Kamera öffnen – und ganz unten
   **„Selbst eingeben – KI überspringen"**.
2. Das Foto wird **schon auf dem Handy verkleinert** (max. 1000 px, WebP), damit
   keine 50-MP-Datei übertragen oder analysiert wird. Das Formular ist **sofort
   bedienbar**, während die Analyse im Hintergrund läuft – Name, Maße und
   Volumen kannst du schon eintragen; Ergebnisse werden nur in noch leere Felder
   übernommen und überschreiben nichts. **Bitte kurz prüfen** – KI-Werte sind
   Vorschläge und editierbar.

   Für den Ablageort zählen die Maße (L × B × H); daraus berechnet Storder das
   Volumen. Alternativ kannst du ein Volumen in Litern eintragen. Häkchen aus =
   keine Analyse, alles manuell; der Knopf unten öffnet das Formular auch ohne
   Foto und bricht eine laufende Analyse ab.
3. Der Ablageort erscheint automatisch – **passend zur Kategorie**: „Küche“
   landet eher in *Küche & Vorrat* als in *Dokumente & Papier*, auch wenn dort
   mehr Platz frei wäre. Kisten, die inhaltlich passen, sind mit ★ markiert.
   Angezeigt werden Kiste, freie Position und Füllstand nach dem Einlagern.
4. **Stückzahl** (Feld neben Gewicht/Volumen): 3 Exemplare belegen auch das
   3-fache Volumen und zählen beim Füllstand mit. Oft erkennt Storder schon
   ähnliche Artikel („Kennst du schon?“) und schlägt deren Kiste vor; ein Tipp
   übernimmt sie.
5. **Ablageort antippen** – du kannst jede Kiste mit genug Platz manuell
   wählen (zu kleine Kisten sind ausgegraut). „Automatisch wählen“ setzt den
   Vorschlag zurück.
6. **Einlagern** – der Gegenstand ist katalogisiert (Zeitstempel) und über die
   Suche auffindbar. Ein Doppelklick-Schutz verhindert versehentliche Dubletten
   (gleicher Name in derselben Kiste innerhalb von 10 Sekunden wird abgelehnt). Passt nichts, schlägt Storder eine größere Kiste vor
   (mit Mindestvolumen).
7. **Posteingang** – für Stapel: Foto wählen und **„In den Posteingang
   (schnell)"** tippen, ohne Formular. Der Tab **Posteingang** zeigt alle noch
   nicht eingelagerten Artikel (Badge mit Anzahl); dort gibt es pro Artikel
   **Einlagern**, **Bearbeiten** und **„Alle einlagern"** für den ganzen Stapel.
   Die KI-Erkennung läuft im Hintergrund weiter, während du die Kiste einräumst.

   Beim Öffnen eines Posteingang-Artikels zeigt Storder den **Kisten-Vorschlag**
   (z. B. „Vorschlag: B6 · Dokumente & Papier · 21,9 l frei") und erlaubt direkt
   die Auswahl: **„Einlagern (B6)"** nimmt den Vorschlag, **„Andere Kiste"**
   listet alle Kisten mit genug Platz. Im Bearbeiten-Dialog gibt es dafür
   **„Nach dem Speichern einlagern"** plus eine Kisten-Auswahl („Automatisch"
   oder eine bestimmte Kiste) – Details speichern und einlagern in einem Schritt.
8. **Rotes ✕** (statt „Verwerfen“) öffnet drei große Optionen:
   **Passt nicht** (Maße prüfen, Kiste ausschließen, neu suchen),
   **Kiste voll** (Kiste ausschließen, anderen Platz suchen) und
   **Verwerfen** (Eingabe komplett verwerfen).
9. **Artikel bearbeiten** – in Suche oder Kisteninhalt auf *Bearbeiten*:
   Beschreibung, Kategorie, Marke, **Kaufdatum**, **Kaufpreis (optional)**,
   weitere **Fotos** (mehrere, jederzeit ergänz-, **dreh- und löschbar**) sowie die
   **Originalrechnung**:
   * **„In Paperless suchen“** durchsucht dein Paperless-ngx im LAN
     (Volltextsuche mit Name/Marke/Kaufjahr, Ergebnisliste mit Datum und
     Korrespondent). Ein Tipp **verlinkt** das Dokument in Paperless
     (`…/documents/<id>`) – es wird **keine Kopie** in Storder angelegt; die
     Rechnung öffnet sich aus der App direkt in Paperless.
   * Alternativ Datei hochladen (PDF/JPG/PNG/WebP). Die Rechnung ist danach im
     Artikel verlinkt und direkt abrufbar.
10. **Kisten** – Füllstand je Kiste als **Balkendiagramm mit Prozentwert**
   (grün < 75 %, orange ab 75 %, rot ab 95 %), Inhalt ansehen, umräumen,
   bearbeiten. Ist eine Kiste physisch voll (auch wenn rechnerisch noch Luft
   ist), lässt sie sich direkt in der Liste über **„Kiste voll"** markieren –
   Chip, Balken (100 %) und Prozent-Label zeigen dann **„voll"**, der
   rechnerische Füllstand steht als Zusatzinfo daneben; große Gegenstände werden
   dort nicht mehr vorgeschlagen (nur noch Kleinteile bis 2 l). Dasselbe geht
   im Bearbeiten-Dialog über den **Füllstatus**. Im Dialog lässt sich außerdem
   ein **Foto der Kiste (außen)** hinterlegen, das als Vorschaubild erscheint.
   Eine als **voll** markierte Kiste wird künftig nur noch für **sehr kleine
   Gegenstände** (bis 2 l) vorgeschlagen; über *Wieder freigeben* ist die
   Markierung jederzeit aufhebbar.
   **Kiste entfernen** fragt, ob der Inhalt erhalten bleiben soll (Gegenstände
   sind danach „ohne Kiste") oder **mit der Kiste gelöscht** wird (inkl. Fotos
   und Rechnungen).
11. **Ansicht umschalten** – **Raster ist Standard** (3 Kacheln pro Reihe); der
   Knopf **„3/Reihe"** schaltet auf **2 pro Reihe** um (wird gemerkt), der
   Knopf **„Liste"** auf die Listenansicht. Gilt für Kisten-Inhalt, Suche und
   Posteingang.
12. **Artikel ansehen & bearbeiten** – ein Tipp auf Karte oder Kachel öffnet die
   **Ansicht**: große Fotos (antippen = Vollbild), alle Daten, Rechnungslink.
   Erst das **Stift-Symbol ✎** wechselt in den Bearbeiten-Modus (Beschreibung,
   Kategorie, Marke, **Maße/Gewicht/Form**, Stückzahl, Kaufdaten, Fotos,
   Rechnung). Geänderte Maße werden in der Kiste **neu platziert**; passt der
   Gegenstand nicht mehr, bleibt alles unverändert und es erscheint ein Hinweis.
13. **Suche** – findet über Name, Beschreibung, Marke, Kategorie, Kisten-Code und
   Ort (z. B. „A23“ oder „Werkstatt“). Über die **Kategorie-Chips** (mit Anzahl)
   lässt sich der Bestand filtern, auch mehrere Kategorien gleichzeitig; „Alle"
   hebt den Filter auf.
14. **Prüfen** – nach dem eingestellten Zeitraum erscheinen zufällige
   Gegenstände: *Behalte ich*, *Nutze ich nicht*, *Aussortieren* oder
   *Nicht gefunden*. Aussortierte wandern aus dem Bestand.

---

## Paperless-ngx im lokalen Netz

Storder liest nur aus Paperless (kein Schreibzugriff, keine Uploads dorthin).
Es gibt zwei Varianten – eine davon reicht:

**A) Ohne Token, mit Benutzername/Passwort** (einfachste Variante)

```env
PAPERLESS_URL=http://192.168.1.50:8000
PAPERLESS_USERNAME=dein-benutzer
PAPERLESS_PASSWORD=dein-passwort
```

Storder ruft beim ersten Zugriff `POST /api/token/` auf, holt sich den Token und
merkt ihn sich im Speicher (nicht in der Datenbank). Wird der Token ungültig,
loggt sich Storder automatisch einmal neu ein.

**B) Mit API-Token** (falls dein Paperless keinen Login über die API erlaubt,
z. B. bei SSO/MFA)

```env
PAPERLESS_URL=http://192.168.1.50:8000
PAPERLESS_TOKEN=dein-token
```

Den Token findest du in Paperless unter *Einstellungen → Users & Groups →
Benutzer bearbeiten → „API Token“* (in älteren Versionen das Token-Symbol neben
dem Benutzer). Paperless-ngx hat also sehr wohl einen API-Token – er ist nur
etwas versteckt.

Danach im Artikel auf *Bearbeiten* → **„In Paperless suchen“**. Der Suchbegriff wird
   aus Name, Marke und Kaufjahr gebildet (`… 2024 Rechnung`), lässt sich aber
   überschreiben. Treffer zeigen Titel, Datum, Korrespondent und Tags; ein Tipp
   lädt das Originaldokument (PDF/Bild) und verlinkt es am Artikel.

Bei einem selbstsignierten HTTPS-Zertifikat im LAN hilft für den Container
`NODE_TLS_REJECT_UNAUTHORIZED=0` (nur im vertrauenswürdigen Heimnetz) oder ein
Reverse-Proxy mit gültigem Zertifikat.

Ist Paperless nicht konfiguriert, bleibt der normale Datei-Upload verfügbar.
Fehler (Token abgelehnt, nicht erreichbar, Zeitüberschreitung) werden im Dialog
im Klartext angezeigt.

## Wie gerechnet wird

* **Artikelzeilen** zeigen Maße, Kategorie/Marke und Datum – Liter stehen nur
  dort, wo sie für Entscheidungen zählen (Kisten, Ablagevorschlag, Editor).
* **Stückzahl**: Das Volumen einer Einheit wird mit der Stückzahl multipliziert;
  Füllstand, Gewicht und Platzprüfung rechnen mit allen Exemplaren.
* **Volumen** = Bounding-Box der Maße × 1,08 pro Kante (Griff-/Verpackungs-
  toleranz) × Formfaktor (Quader 1,0 · Zylinder 0,785 · Flasche 0,7 ·
  Kugel 0,524 · Beutel 0,75 · unregelmäßig 0,65) × 1,25 Packluft.
  Fehlen Maße, wird über die Dichte (≈ 0,35 g/cm³) geschätzt und als unsicher
  markiert; ohne alles gilt ein Standard von 5 l mit Warnung.
* **Platzierung**: achsparalleles 3D-Packing. Jede Kiste hat Innenmaße und eine
  optionale Füllhöhe; Gegenstände werden in 6 Ausrichtungen von unten nach oben,
  hinten nach vorne, links nach rechts gepackt – deterministisch. Ergebnis ist
  eine konkrete Position (x/y/z in cm) plus belegte Größe.
* **Kistenwahl**: Zuerst müssen Maße, Volumen und Gewicht passen. Unter den
  passenden Kisten gewinnt die **inhaltlich passende Kategorie** (Textabgleich
  mit Kistenname/-ort, inkl. deutscher Synonyme und Komposita: „Weihnachtsdeko“
  trifft „Deko“, „Bastelmaterial“ trifft „Basteln“). Danach entscheidet der
  Füllstand: Kisten werden bevorzugt, die nach dem Einlagern gut nutzbar
  bleiben und nicht unnötig groß sind. Ist keine Kiste passend, kommen die
  Gründe mit (zu groß, zu wenig Volumen, kein freier Platz, als voll markiert,
  inaktiv) – daraus entsteht der Vorschlag „größere Kiste“. Als **voll
  markierte** Kisten (Knopf *Kiste voll* beim Ablehnen) nehmen nur noch
  Kleinteile bis 2 l auf und stehen dann hinter gleichwertigen freien Kisten.

Kisten können statt mit Maßen auch nur mit **Volumen in Litern** angelegt werden;
daraus werden würfelförmige Innenmaße abgeleitet.

---

## API (Auszug)

Alles JSON, keine Authentifizierung – bitte nur im vertrauenswürdigen Heimnetz
betreiben (oder hinter VPN/Reverse-Proxy mit Auth).

| Methode & Pfad | Zweck |
| --- | --- |
| `GET /api/health` | Status, ob ein LLM-Key konfiguriert ist |
| `GET /api/stats` | Kisten, Gegenstände, Volumen, Gewicht |
| `GET/POST /api/bins`, `PUT/DELETE /api/bins/:id` | Kisten verwalten (`?with_items=1` löscht den Inhalt mit) |
| `GET/POST /api/items`, `PUT/DELETE /api/items/:id` | Gegenstände verwalten (`PUT` mit `dims_cm` platziert neu) |
| `GET /api/items?bin_id=…` | Inhalt einer Kiste |
| `POST /api/items/:id/move` | umräumen (`bin_id` oder `"auto"`) |
| `GET /api/categories` | Kategorien mit Anzahl (für die Filter-Chips) |
| `GET /api/search?q=…&categories=A,B` | Freitextsuche, optional nach Kategorien gefiltert |
| `POST /api/analyze` | `{ image: dataURL, hint? }` → Produktdaten + Foto |
| `POST /api/suggest` | `{ dims_cm, weight_g?, category?, name?, quantity?, volume_liters?, prefer_box_id?, exclude_box_ids? }` → Ablageort (inkl. `category_match`) |
| `GET /api/recall` | fällige Gegenstände zur Prüfung |
| `POST /api/recall/:id` | `{ verdict: keep\|unused\|discard\|not_found }` |
| `POST/DELETE /api/bins/:id/full` | Kiste als voll markieren / freigeben |
| `GET /api/inbox` | Artikel ohne Kiste (Posteingang) |
| `POST /api/inbox` | Schnell-Erfassung `{ image, hint? }` → Artikel im Posteingang |
| `POST /api/inbox/assign` | Stapel einlagern (`{ ids? }`, leer = alle) |
| `GET /api/items/similar?q=&category=` | ähnliche vorhandene Artikel + Kiste |
| `POST /api/items/:id/photos` | weitere Fotos (`{ images: [dataURL…] }`) |
| `POST/GET/DELETE /api/bins/:id/photo` | Kistenfoto setzen / abrufen / entfernen |
| `DELETE /api/items/:id/photos/:name` | Foto entfernen |
| `POST /api/items/:id/photos/:name/rotate` | Foto drehen (`{ direction: "left"\|"right" }` oder `{ degrees: 90\|180\|270 }`) |
| `POST /api/items/:id/invoice` | Rechnung als Datei (`{ file, name }`) |
| `GET /api/items/:id/invoice` | Rechnung ansehen (PDF/Bild) |
| `POST /api/items/:id/invoice/paperless` | Paperless-Dokument verlinken (`{ document_id }`, keine Kopie) |
| `GET /api/items/:id/invoice/search?q=` | Paperless durchsuchen |
| `GET /api/paperless/status` | Paperless konfiguriert? |
| `GET/PUT /api/settings` | Laufzeit-Einstellungen |

Beispiel:

```bash
curl -X POST http://localhost:8080/api/suggest \
  -H 'content-type: application/json' \
  -d '{"dims_cm":{"length_cm":30,"width_cm":20,"height_cm":20},"weight_g":1500}'
```

---

## Datenschutz & Sicherheit

* Fotos und Produktdaten werden an den konfigurierten LLM-Anbieter geschickt
  (bei OpenRouter inkl. optionaler Websuche). Wer das nicht will: `LLM_WEB_SEARCH=false`
  setzen oder einen eigenen OpenAI-kompatiblen Endpunkt (`LLM_BASE_URL`)
  verwenden – inklusive lokalem Modell.
* Alle anderen Daten bleiben lokal: SQLite-Datei, Fotos und Rechnungen im
  `DATA_DIR`. Paperless wird nur gelesen (Suche + Dokument-Download).
* Kein Login. Für Zugriff von außerhalb: Reverse-Proxy mit HTTPS/Basic-Auth
  oder VPN davor. Für die Kamera am Handy ist HTTP im Heimnetz ausreichend.
* Uploads werden serverseitig per `sharp` auf **max. 1000 px** verkleinert und
  als **WebP** gespeichert (fürs LLM zusätzlich JPEG, weil nicht jeder Anbieter
  WebP akzeptiert); das Original wird nicht behalten.

---

## Entwicklung & Tests

```bash
npm run dev     # Server mit Auto-Reload
npm test        # node:test – Geometrie, Packing, Platzierung, DB, API, Analyse
```

Struktur:

```
src/server.js      Express-App, Routen, Foto-Upload, Start
src/analyze.js     Foto -> Vision + Websuche -> einheitliche Produktdaten
src/db.js          SQLite-Schema und alle Abfragen (node:sqlite)
src/recall.js      Auswahl/Scheduling der Prüf-Erinnerung
lib/category.js    Kategorie-Zuordnung (Textabgleich, Synonyme, Komposita)
lib/geometry.js    Volumen, Einheiten, Toleranzen (pure functions)
lib/placement.js   3D-Packing und Kistenbewertung (pure functions)
lib/suggest.js     verbindet Volumen + Packing zum Ablagevorschlag
lib/llm.js         OpenAI-kompatibler Client (OpenRouter-Default)
lib/paperless.js   Paperless-ngx-Client (Suche + Dokument-Download)
lib/similar.js     Ähnlichkeitssuche ("gibt es das schon?")
lib/validate.js    Eingabevalidierung
public/            mobile Web-App (HTML/CSS/JS, kein Build)
```

## Upgrade bestehender Installationen

Das Schema wird beim Start automatisch migriert (neue Spalten für
Kisten-Markierung, Kaufdaten und Rechnungen). Vorher ein Backup von
`DATA_DIR/storder.db` machen – die Migration ist additiv und verliert keine Daten.

## Lizenz

MIT
