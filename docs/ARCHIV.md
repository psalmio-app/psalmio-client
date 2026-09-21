# Ein Archiv nach Psalmio bringen

Für Gemeinden, die nicht bei null anfangen: Auf einem NAS oder einer Festplatte
liegen die Gottesdienste der letzten Jahre, und sie sollen in die Mediathek.
Diese Anleitung beschreibt den Weg – entstanden beim ersten solchen Import, rund
400 Aufnahmen aus zwei Jahren.

**Das Wichtigste vorweg:** Das Hochladen ist der leichte Teil, den nimmt einem
`psalmio batch` ab. Die Arbeit steckt davor – in der Frage, *welche Datei zu
welchem Termin gehört*. Die kann nur die Gemeinde selbst beantworten, weil jede
ihre Aufnahmen anders ablegt.

## Was am Ende passiert – und was nicht

Für jede Datei holt Psalmio den Termin mit seinem Ablauf aus ChurchTools (falls
es ihn noch nicht kennt), nimmt die Aufnahme entgegen und verarbeitet Ton und
Bild. Danach liegt der Gottesdienst **unveröffentlicht** im Editor. Dort schaut
jemand darüber, legt mit „Auto" die Beiträge auf die Aufnahme und entscheidet,
ob er in die Mediathek kommt.

- **Veröffentlicht wird nichts von selbst.** Niemand muss vorab entscheiden, was
  die Gemeinde sehen darf – das passiert im Editor, Gottesdienst für Gottesdienst.
- **Vorhandenes wird nie überschrieben.** Hat ein Termin schon eine Aufnahme,
  wird die Datei übersprungen.
- **KI-Auswertung und YouTube laufen nicht an**, solange niemand im Editor
  gespeichert hat.

## Schritt 1: Bestandsaufnahme

Bevor irgendetwas hochgeladen wird, diese Fragen beantworten – am besten
schriftlich, nur lesend, ohne am Archiv etwas zu ändern:

1. **Wo liegen die Gesamtaufnahmen?** Ein Ort oder mehrere? Nach welchem Schema
   sind Ordner und Dateien benannt, und seit wann gilt es?
2. **Wie viele Dateien, wie viel Platz?** Eine Liste mit Pfad, Größe und
   Änderungsdatum.
3. **Welche Formate?** `ffprobe` über eine Stichprobe (ein Dutzend Dateien aus
   verschiedenen Zeiten und Räumen reicht meist): Bildcodec, Auflösung, Bildrate,
   Bitrate, Toncodec, weitere Spuren.
4. **Roh oder komprimiert?** Gibt es beide Fassungen, woran erkennt man sie, und
   gibt es je Termin beide oder nur eine?
5. **Gibt es irgendwo schon eine Zuordnung Datei ↔ Termin?** Eine Datenbank, ein
   Protokoll der Aufnahmesoftware, IDs im Dateinamen?
6. **Taugen die Zeitstempel der Dateien als Datum?** Meist nicht – wer sein
   Archiv einmal neu komprimiert hat, findet dort den Tag der Komprimierung.
   Verlässlicher ist ein Datum im Namen.
7. **Mehrteilige Aufnahmen:** Termine mit mehreren Dateien (Teil 1/2, Fehlstart
   und Neustart, zusammengefügte Fassung neben den Teilen). Für Psalmio braucht
   es **je Termin genau eine Datei**.
8. **Was gehört nicht hinein?** Einzelaufnahmen (Lieder, Predigtausschnitte),
   Testdateien, defekte Dateien, Veranstaltungen außerhalb der Kalender, die
   Psalmio führt.

Was die Stichprobe für den Import bedeutet:

| Die Datei hat … | dann … |
|---|---|
| H.264, höchstens 1920×1080 und 50 fps, gesamt höchstens 6 Mbit/s, Ton AAC | übernimmt Psalmio sie unverändert – Minuten |
| dasselbe Bild, aber anderen Ton (MP3, PCM) | tauscht Psalmio nur den Ton – Minuten |
| mehr als 6 Mbit/s, anderen Codec, größer als 1080p | rechnet Psalmio das Bild neu – **Stunden je Datei**. Besser vorher selbst komprimieren |
| mehr als 15 GB | muss sie vorher komprimiert werden |

Weitere Spuren (Zeitcode, ein Titelbild als zweite Videospur) stören nicht:
Psalmio nimmt die erste Bild- und die erste Tonspur.

## Schritt 2: Das Manifest

Eine tabulatorgetrennte Datei mit zwei Spalten, die zählen – weitere dürfen
dabeistehen (Methode, Sicherheit, Bemerkung) und helfen beim Nachvollziehen:

```
pfad	ct_id	bemerkung
/archiv/2026/2026-01-18_1000_Gottesdienst.mp4	4870
/archiv/2026/2026-01-25_1000_Gottesdienst.mp4	4873	Uhrzeit wich 1 min ab
```

- `ct_id` ist die ID des **Events** in ChurchTools. Kalendereinträge ohne Event
  kennt Psalmio nicht als Gottesdienst; an ihnen kann keine Aufnahme hängen.
- **Je Termin genau eine Zeile** – steht ein Termin zweimal da, bricht der Lauf
  mit einem Hinweis ab, bevor etwas hochgeladen wird.
- Zeilen ohne `ct_id` werden ausgelassen. So kann dieselbe Datei auch das
  festhalten, was bewusst nicht mitkommt.

Wie man zur ID kommt, hängt am Archiv. Bewährt hat sich, in dieser Reihenfolge
zu suchen und die Methode mitzuschreiben: ID im Dateinamen → Datum, Uhrzeit und
Raum gegen die Termine aus ChurchTools → von Hand. **IDs im Dateinamen
nachprüfen**, wenn am selben Tag mehrere Termine liegen (Trauung und Feier,
Morgen- und Abendveranstaltung): Beim ersten Import trugen drei von vierhundert
Dateien die ID des Nachbartermins.

## Schritt 3: Probelauf

```bash
export PSALMIO_URL=https://gemeinde.psalmio.de
export PSALMIO_API_KEY=…            # Einstellungen → API-Keys, Berechtigung „Videotechnik"

psalmio status
psalmio batch manifest.tsv --dry-run
```

`--dry-run` lädt nichts hoch: Es zählt die Termine, meldet fehlende Dateien und
die Gesamtgröße. Liegen die Dateien auf dem Rechner woanders als im Manifest,
hilft `--root-from /mnt/nas --root-to /Volumes/Archiv`.

Dann ein kleines Manifest mit **einer Datei je Formatklasse** aus Schritt 1
wirklich hochladen und im Editor ansehen: Stimmen Bild und Ton, stimmt der
Termin, liegt der Ablauf daneben? Erst danach das Ganze.

## Schritt 4: Der Lauf

```bash
psalmio batch manifest.tsv --window 22:00-06:00
```

- **Der Server bestimmt das Tempo, nicht die Leitung.** Ton und Bild eines
  Gottesdienstes brauchen bei Psalmio rund eine Viertelstunde Rechenzeit,
  nacheinander. Vor jeder Datei wartet der Lauf deshalb, bis die vorige fertig
  ist. Vierhundert Aufnahmen sind so etwa vier Tage – planbar mit
  `--window`, damit der Sonntag frei bleibt.
- **Abbrechen kostet nichts.** Der Stand steht in `manifest.tsv.stand.json`.
  Strg+C, Neustart des Rechners, Stromausfall: Der nächste Aufruf überspringt
  Erledigtes und setzt einen halben Upload an derselben Stelle fort.
- **Das jüngste Jahr zuerst** – das wird am ehesten gehört.

Am Ende steht eine Bilanz. Was die Einträge in der Stand-Datei bedeuten:

| Status | Bedeutung | Was tun |
|---|---|---|
| `done` | übernommen, wird verarbeitet | im Editor prüfen |
| `exists` | für den Termin lag schon eine Aufnahme vor | nichts – oder im Editor nachsehen, welche dort liegt |
| `unknown` | Psalmio führt den Termin nicht: anderer Kalender, ausgeschlossen, in ChurchTools gelöscht | bei Bedarf im Editor von Hand anlegen und dort hochladen |
| `failed` | mehrfach versucht und gescheitert; der Grund steht dabei | Grund beheben, Lauf neu starten – nur diese Einträge werden wiederholt |

## Platz

Ein Gottesdienst mit Video belegt in Psalmio rund 2 bis 2,5 GB (das Video und
vier Tonfassungen), nur mit Ton rund 0,5 GB. Vor dem Import mit Psalmio klären,
ob das Kontingent der Gemeinde reicht.
