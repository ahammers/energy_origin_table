# Energy Origin Table

Lovelace custom card fuer Home Assistant, die den Verbrauch konfigurierter Energiegeraete rechnerisch auf PV direkt, Batterieentladung und Netzbezug verteilt.

Die Karte liest vorhandene Langzeitstatistiken im Browser aus. Sie erzeugt keine Sensoren, schreibt keine Daten und veraendert das Energy Dashboard nicht.

## Minimal-Konfiguration

```yaml
type: custom:energy-origin-table
title: Energieherkunft
days: 30
```

Falls die automatische Erkennung in deiner Home-Assistant-Version nicht funktioniert, kann die Karte vollstaendig manuell konfiguriert werden. Details stehen in der README.
