# Energy Origin Table

Eine Home-Assistant-Lovelace-Custom-Card, die vorhandene Energie-Langzeitstatistiken im Browser auswertet und fuer konfigurierte Einzelgeraete zeigt, aus welchen rechnerischen Quellen der Verbrauch stammt:

- PV direkt
- Batterieentladung
- Netzbezug

Die Karte erzeugt keine Sensoren, schreibt keine Daten und veraendert weder bestehende Entities noch das Energy Dashboard.

## Installation ueber HACS

1. Dieses Verzeichnis als eigenes GitHub-Repository veroeffentlichen.
2. In HACS ein benutzerdefiniertes Repository hinzufuegen.
3. Kategorie `Dashboard` auswaehlen.
4. Repository installieren.
5. Browser neu laden.

> Empfehlung: Das GitHub-Repository sollte `energy-origin-table` heissen, damit Dateiname und Repository-Name zu den HACS-Dashboard-Regeln passen.

## Minimal-Konfiguration

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30
```

Die Karte versucht dann, PV, Netz, Batterie und Geraete aus der Energy-Dashboard-Konfiguration zu lesen.

## Farben anpassen

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30

colors:
  pv: "#43a047"
  battery: "#fbc02d"
  grid: "#e53935"
```

## Statistikmodus fuer berechnete Helfer

Berechnete Summenwert-Helfer koennen kurzzeitig falsche Tief- oder Hochpunkte liefern, wenn eine Quelle des Helfers voruebergehend `0` meldet. Die Karte entfernt solche deutlichen Ausreisser aus der kumulativen Reihe und verteilt den Verbrauch bis zum naechsten plausiblen Punkt ueber die betroffene Zeitspanne.

Normalerweise erkennt die Karte das automatisch ueber die Entity-Zustandsklasse:

- `total` / Summenwert: Zustandsdifferenz mit Ausreisserbereinigung
- `total_increasing`: Recorder-`sum`

Die folgende Konfiguration ist nur als Override fuer Sonderfaelle gedacht.

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30

device_statistic_modes:
  sensor.keller_total_energy_without_wallbox: state
  sensor.erdgeschoss_total_active_energy: state
```

Echte Shelly-Energiezaehler wie `sensor.obergeschoss_total_active_energy` oder `sensor.wallbox_total_active_energy` koennen auf `auto` bleiben.

## Debug-Ausgabe

Zur Analyse von Statistikproblemen kann unterhalb der Tabelle ein kopierbarer JSON-Block angezeigt werden.

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30
debug: true
```

Die Ausgabe enthaelt erkannte Quellen und Geraete, Entity-Attribute, Statistik-Metadaten, erste und letzte Recorder-Punkte sowie die aus `sum` und `state` berechneten Gesamtwerte.

## Manueller Fallback

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30
use_energy_dashboard: false

pv_energy: sensor.deine_pv_energie
grid_import_energy: sensor.dein_netzbezug
grid_export_energy: sensor.deine_einspeisung
battery_discharge_energy: sensor.deine_batterieentladung
battery_charge_energy: sensor.deine_batterieladung

devices:
  - entity: sensor.waermepumpe_energie
    name: Waermepumpe (K)

  - entity: sensor.wallbox_energie
    name: Wallbox
```

## Hinweise

- Die Karte nutzt Home-Assistant-Langzeitstatistiken und wertet standardmaessig die letzten 30 Tage aus.
- Energiezaehler muessen eine auswertbare `sum`-Statistik besitzen.
- Die Recorder-Abfrage normalisiert Energie-Statistiken nach `kWh`, damit `Wh` und `kWh` nicht gemischt ausgewertet werden.
- Bei berechneten Summenwert-Helfern werden deutliche Tief- und Hochpunkt-Ausreisser aus der kumulativen Reihe entfernt. Der Verbrauch bis zum naechsten plausiblen Punkt wird ueber die betroffene Zeitspanne verteilt.
- Batterie ist optional. Wenn keine Batteriequelle gefunden wird, wird der Batterieanteil als `0` behandelt.
- Es wird bewusst keine Gesamtsumme ueber alle Tabellenzeilen gebildet, da Bereichs- und Einzelgeraete parallel enthalten sein koennen.

## Entwicklung ohne HACS

Datei nach Home Assistant kopieren:

```text
/config/www/energy-origin-table.js
```

Resource in Lovelace:

```text
/local/energy-origin-table.js?v=1
```

Karte:

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30
```
