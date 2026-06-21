class EnergyOriginTable extends HTMLElement {
  static getStubConfig() {
    return {
      title: "Energieherkunft",
      days: 30,
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._state = { status: "idle" };
    this._sort = { key: "default", direction: "asc" };
    this._loadKey = "";
    this._number = new Intl.NumberFormat("de-AT", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  setConfig(config) {
    if (!config) {
      throw new Error("Konfiguration fehlt.");
    }

    this._config = {
      title: "Energieherkunft",
      days: 30,
      use_energy_dashboard: true,
      colors: {
        pv: "#43a047",
        battery: "#fbc02d",
        grid: "#e53935",
      },
      ...config,
      colors: {
        pv: "#43a047",
        battery: "#fbc02d",
        grid: "#e53935",
        ...(config.colors || {}),
      },
    };

    if (!Number.isFinite(Number(this._config.days)) || Number(this._config.days) <= 0) {
      throw new Error("days muss eine positive Zahl sein.");
    }

    this._loadKey = "";
    this._render();
    this._requestLoad();
  }

  set hass(hass) {
    this._hass = hass;
    this._requestLoad();
  }

  getCardSize() {
    const rowCount = this._state && this._state.rows ? this._state.rows.length : 4;
    return Math.max(3, Math.min(12, rowCount + 2));
  }

  _requestLoad() {
    if (!this._hass || !this._config || !this._config.days) {
      return;
    }

    const loadKey = JSON.stringify({
      days: Number(this._config.days),
      useEnergyDashboard: this._config.use_energy_dashboard !== false,
      manual: {
        pv: this._config.pv_energy,
        gridImport: this._config.grid_import_energy,
        gridExport: this._config.grid_export_energy,
        batteryDischarge: this._config.battery_discharge_energy,
        batteryCharge: this._config.battery_charge_energy,
        devices: this._config.devices || [],
      },
    });

    if (this._loadKey === loadKey || this._state.status === "loading") {
      return;
    }

    this._loadKey = loadKey;
    this._loadData();
  }

  async _loadData() {
    this._state = { status: "loading" };
    this._render();

    try {
      const end = new Date();
      const start = new Date(end.getTime() - Number(this._config.days) * 24 * 60 * 60 * 1000);
      const resolved = await this._resolveEnergyConfig();
      const statsIds = this._unique([
        resolved.sources.pv,
        resolved.sources.gridImport,
        resolved.sources.gridExport,
        resolved.sources.batteryDischarge,
        resolved.sources.batteryCharge,
        ...resolved.devices.map((device) => device.statisticId),
      ].filter(Boolean));

      if (!resolved.sources.pv || !resolved.sources.gridImport || !resolved.sources.gridExport) {
        throw new Error("PV, Netzbezug oder Netzeinspeisung konnte nicht ermittelt werden.");
      }

      if (!resolved.devices.length) {
        throw new Error("Keine Ger\u00e4te mit Energie-Langzeitstatistik gefunden.");
      }

      const metadata = await this._loadStatisticMetadata(statsIds);
      const raw = await this._loadStatistics(statsIds, start, end);
      const series = this._buildDeltaSeries(raw.data, metadata, raw.normalizedToKwh ? "kWh" : null);
      const result = this._calculateRows(resolved, series, start, end);

      this._state = {
        status: "ready",
        ...result,
        resolved,
      };
      this._render();
    } catch (error) {
      this._state = {
        status: "error",
        message: error && error.message ? error.message : String(error),
      };
      this._render();
    }
  }

  async _resolveEnergyConfig() {
    const manual = this._manualConfig();
    if (this._config.use_energy_dashboard === false) {
      return manual;
    }

    let dashboard = null;
    try {
      dashboard = await this._loadEnergyPreferences();
    } catch (error) {
      if (this._hasManualSources(manual)) {
        return manual;
      }
        throw new Error(`Energy-Dashboard-Konfiguration konnte nicht gelesen werden: ${error.message || error}`);
    }

    const automatic = this._extractEnergyPreferences(dashboard);
    const merged = {
      sources: {
        pv: manual.sources.pv || automatic.sources.pv,
        gridImport: manual.sources.gridImport || automatic.sources.gridImport,
        gridExport: manual.sources.gridExport || automatic.sources.gridExport,
        batteryDischarge: manual.sources.batteryDischarge || automatic.sources.batteryDischarge,
        batteryCharge: manual.sources.batteryCharge || automatic.sources.batteryCharge,
      },
      devices: manual.devices.length ? manual.devices : automatic.devices,
    };

    return merged;
  }

  _manualConfig() {
    return {
      sources: {
        pv: this._config.pv_energy,
        gridImport: this._config.grid_import_energy,
        gridExport: this._config.grid_export_energy,
        batteryDischarge: this._config.battery_discharge_energy,
        batteryCharge: this._config.battery_charge_energy,
      },
      devices: Array.isArray(this._config.devices)
        ? this._config.devices
            .map((device) => ({
              statisticId: device.statistic_id || device.statisticId || device.entity,
              name: device.name || this._friendlyName(device.entity) || device.entity,
            }))
            .filter((device) => device.statisticId)
        : [],
    };
  }

  _hasManualSources(config) {
    return Boolean(config.sources.pv && config.sources.gridImport && config.sources.gridExport && config.devices.length);
  }

  async _loadEnergyPreferences() {
    const commands = [
      { type: "energy/get_prefs" },
      { type: "energy/get_preferences" },
    ];

    let lastError = null;
    for (const command of commands) {
      try {
        return await this._hass.callWS(command);
      } catch (error) {
        lastError = error;
      }
    }
      throw lastError || new Error("Unbekannter Fehler beim Lesen der Energy-Prefs.");
  }

  _extractEnergyPreferences(prefs) {
    const sources = {
      pv: null,
      gridImport: null,
      gridExport: null,
      batteryDischarge: null,
      batteryCharge: null,
    };

    const energySources = Array.isArray(prefs && prefs.energy_sources) ? prefs.energy_sources : [];
    for (const source of energySources) {
      if (source.type === "solar" && !sources.pv) {
        sources.pv = this._pickStatisticId(source, [
          "stat_energy_from",
          "statistic_id",
          "entity_energy_from",
          "entity_id",
        ]);
      }

      if (source.type === "grid") {
        const from = this._firstArrayItem(source.flow_from);
        const to = this._firstArrayItem(source.flow_to);
        sources.gridImport = sources.gridImport || this._pickStatisticId(from || source, [
          "stat_energy_from",
          "statistic_id",
          "entity_energy_from",
          "entity_id",
        ]);
        sources.gridExport = sources.gridExport || this._pickStatisticId(to || source, [
          "stat_energy_to",
          "statistic_id",
          "entity_energy_to",
          "entity_id",
        ]);
      }

      if (source.type === "battery") {
        sources.batteryDischarge = sources.batteryDischarge || this._pickStatisticId(source, [
          "stat_energy_from",
          "statistic_id",
          "entity_energy_from",
          "entity_id",
        ]);
        sources.batteryCharge = sources.batteryCharge || this._pickStatisticId(source, [
          "stat_energy_to",
          "entity_energy_to",
        ]);
      }
    }

    const devices = this._uniqueDevices((prefs.device_consumption || [])
      .map((device) => {
        const statisticId = this._pickStatisticId(device, [
          "stat_consumption",
          "statistic_id",
          "entity_consumption",
          "entity_id",
        ]);
        return {
          statisticId,
          name: device.name || this._friendlyName(statisticId) || statisticId,
        };
      })
      .filter((device) => device.statisticId));

    return { sources, devices };
  }

  _firstArrayItem(value) {
    return Array.isArray(value) && value.length ? value[0] : null;
  }

  _pickStatisticId(object, keys) {
    if (!object) {
      return null;
    }
    for (const key of keys) {
      if (typeof object[key] === "string" && object[key]) {
        return object[key];
      }
    }
    return null;
  }

  async _loadStatisticMetadata(statisticIds) {
    try {
      const result = await this._hass.callWS({
        type: "recorder/get_statistics_metadata",
        statistic_ids: statisticIds,
      });

      const metadata = {};
      for (const item of Array.isArray(result) ? result : []) {
        const id = item.statistic_id || item.id;
        if (id) {
          metadata[id] = item;
        }
      }
      return metadata;
    } catch (error) {
      return {};
    }
  }

  async _loadStatistics(statisticIds, start, end) {
    const requestStart = new Date(start.getTime() - 2 * 60 * 60 * 1000);
    const request = {
      type: "recorder/statistics_during_period",
      start_time: requestStart.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: statisticIds,
      period: "hour",
      types: ["sum"],
    };

    try {
      const result = await this._hass.callWS({
        ...request,
        units: {
          energy: "kWh",
        },
      });
      return {
        data: result || {},
        normalizedToKwh: true,
      };
    } catch (error) {
      const result = await this._hass.callWS(request);
      return {
        data: result || {},
        normalizedToKwh: false,
      };
    }
  }

  _buildDeltaSeries(raw, metadata, unitOverride) {
    const series = {};
    for (const [statisticId, points] of Object.entries(raw || {})) {
      const sorted = Array.isArray(points)
        ? [...points].filter((point) => Number.isFinite(Number(point.sum))).sort((a, b) => this._pointTime(a) - this._pointTime(b))
        : [];
      const unit = unitOverride || this._unitFor(statisticId, sorted, metadata);
      const values = new Map();

      for (let index = 1; index < sorted.length; index += 1) {
        const previous = Number(sorted[index - 1].sum);
        const current = Number(sorted[index].sum);
        let delta = current - previous;
        if (!Number.isFinite(delta)) {
          continue;
        }
        if (delta < -0.0001) {
          continue;
        }
        if (delta < 0) {
          delta = 0;
        }
        values.set(this._hourKey(this._pointTime(sorted[index])), this._convertToKwh(delta, unit));
      }

      series[statisticId] = { values, unit };
    }
    return series;
  }

  _unitFor(statisticId, points, metadata) {
    const meta = metadata && metadata[statisticId] ? metadata[statisticId] : {};
    const fromMeta = meta.statistics_unit_of_measurement
      || meta.statistic_unit_of_measurement
      || meta.unit_of_measurement
      || meta.unit;
    const fromPoint = points.find((point) => point.unit_of_measurement || point.unit);
    return fromMeta || (fromPoint && (fromPoint.unit_of_measurement || fromPoint.unit)) || "kWh";
  }

  _convertToKwh(value, unit) {
    const normalized = String(unit || "kWh").trim().toLowerCase();
    if (normalized === "kwh") {
      return value;
    }
    if (normalized === "wh") {
      return value / 1000;
    }
    throw new Error(`Einheit "${unit}" wird nicht unterst\u00fctzt. Unterst\u00fctzt sind Wh und kWh.`);
  }

  _calculateRows(resolved, series, start, end) {
    const sourceValues = {
      pv: this._seriesValues(series, resolved.sources.pv),
      gridImport: this._seriesValues(series, resolved.sources.gridImport),
      gridExport: this._seriesValues(series, resolved.sources.gridExport),
      batteryDischarge: this._seriesValues(series, resolved.sources.batteryDischarge),
      batteryCharge: this._seriesValues(series, resolved.sources.batteryCharge),
    };
    const hourKeys = this._hourKeys(start, end);
    let evaluableHours = 0;
    let missingSourceHours = 0;

    const sharesByHour = new Map();
    for (const key of hourKeys) {
      const pvProduced = sourceValues.pv.get(key);
      const gridImport = sourceValues.gridImport.get(key);
      const gridExport = sourceValues.gridExport.get(key);
      const batteryDischarge = sourceValues.batteryDischarge ? sourceValues.batteryDischarge.get(key) || 0 : 0;
      const batteryCharge = sourceValues.batteryCharge ? sourceValues.batteryCharge.get(key) || 0 : 0;

      if (!Number.isFinite(pvProduced) || !Number.isFinite(gridImport) || !Number.isFinite(gridExport)) {
        missingSourceHours += 1;
        continue;
      }

      const pvDirect = Math.max(pvProduced - gridExport - batteryCharge, 0);
      const sourceTotal = pvDirect + batteryDischarge + gridImport;
      if (sourceTotal <= 0) {
        continue;
      }

      evaluableHours += 1;
      sharesByHour.set(key, {
        pv: pvDirect / sourceTotal,
        battery: batteryDischarge / sourceTotal,
        grid: gridImport / sourceTotal,
      });
    }

    const rows = resolved.devices.map((device) => {
      const deviceValues = this._seriesValues(series, device.statisticId);
      const totals = { pv: 0, battery: 0, grid: 0, total: 0, hours: 0 };

      for (const [key, shares] of sharesByHour.entries()) {
        const consumption = deviceValues.get(key);
        if (!Number.isFinite(consumption) || consumption < 0) {
          continue;
        }
        totals.pv += consumption * shares.pv;
        totals.battery += consumption * shares.battery;
        totals.grid += consumption * shares.grid;
        totals.total += consumption;
        totals.hours += 1;
      }

      return {
        name: device.name,
        statisticId: device.statisticId,
        ...totals,
      };
    }).filter((row) => row.total > 0);

    if (!rows.length) {
      throw new Error("F\u00fcr den gew\u00e4hlten Zeitraum wurden keine auswertbaren Ger\u00e4tedaten gefunden.");
    }

    return {
      rows,
      hourCount: hourKeys.length,
      evaluableHours,
      missingSourceHours,
    };
  }

  _seriesValues(series, statisticId) {
    return statisticId && series[statisticId] ? series[statisticId].values : new Map();
  }

  _hourKeys(start, end) {
    const keys = [];
    const cursor = new Date(start);
    cursor.setMinutes(0, 0, 0);
    if (cursor < start) {
      cursor.setHours(cursor.getHours() + 1);
    }

    while (cursor <= end) {
      keys.push(this._hourKey(cursor.getTime()));
      cursor.setHours(cursor.getHours() + 1);
    }
    return keys;
  }

  _pointTime(point) {
    return new Date(point.start || point.start_time || point.end || point.end_time).getTime();
  }

  _hourKey(time) {
    const date = new Date(time);
    date.setMinutes(0, 0, 0);
    return date.toISOString();
  }

  _render() {
    if (!this.shadowRoot) {
      return;
    }

    const title = this._config.title || "Energieherkunft";
    let body = "";
    if (this._state.status === "loading" || this._state.status === "idle") {
      body = `<div class="state">Energieherkunft wird berechnet ...</div>`;
    } else if (this._state.status === "error") {
      body = `<div class="error">${this._escape(this._state.message)}</div>`;
    } else {
      body = this._renderTable();
    }

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="card-header">${this._escape(title)}</div>
        <div class="content">${body}</div>
      </ha-card>
    `;

    for (const button of this.shadowRoot.querySelectorAll("button[data-sort]")) {
      button.addEventListener("click", () => this._setSort(button.dataset.sort));
    }
  }

  _renderTable() {
    const rows = this._sortedRows(this._state.rows);
    const summary = `Auswertbar: ${this._state.evaluableHours} von ${this._state.hourCount} Stunden`;
    const missing = this._state.missingSourceHours ? `; nicht auswertbar: ${this._state.missingSourceHours}` : "";

    return `
      <div class="summary">${summary}${missing}</div>
      <table>
        <thead>
          <tr>
            ${this._header("name", "Ger\u00e4t")}
            ${this._header("total", "Gesamt")}
            <th>Herkunft</th>
            ${this._header("pv", "PV")}
            ${this._header("battery", "Batterie")}
            ${this._header("grid", "Netz")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => this._renderRow(row)).join("")}
        </tbody>
      </table>
    `;
  }

  _header(key, label) {
    const active = this._sort.key === key;
    const marker = active ? (this._sort.direction === "asc" ? " &#9650;" : " &#9660;") : "";
    return `<th><button type="button" data-sort="${key}">${label}${marker}</button></th>`;
  }

  _renderRow(row) {
    const pvPercent = this._percent(row.pv, row.total);
    const batteryPercent = this._percent(row.battery, row.total);
    const gridPercent = this._percent(row.grid, row.total);
    const title = `PV ${this._format(row.pv)} kWh (${this._format(pvPercent)} %), Batterie ${this._format(row.battery)} kWh (${this._format(batteryPercent)} %), Netz ${this._format(row.grid)} kWh (${this._format(gridPercent)} %)`;

    return `
      <tr>
        <td class="name" title="${this._escape(row.statisticId)}">${this._escape(row.name)}</td>
        <td data-label="Gesamt">${this._format(row.total)} kWh</td>
        <td data-label="Herkunft">
          <div class="bar" title="${this._escape(title)}">
            <span class="pv" style="width:${pvPercent}%"></span>
            <span class="battery" style="width:${batteryPercent}%"></span>
            <span class="grid" style="width:${gridPercent}%"></span>
          </div>
        </td>
        <td data-label="PV">${this._formatValue(row.pv, pvPercent)}</td>
        <td data-label="Batterie">${this._formatValue(row.battery, batteryPercent)}</td>
        <td data-label="Netz">${this._formatValue(row.grid, gridPercent)}</td>
      </tr>
    `;
  }

  _setSort(key) {
    if (this._sort.key === key) {
      this._sort = { key, direction: this._sort.direction === "asc" ? "desc" : "asc" };
    } else {
      this._sort = { key, direction: key === "name" ? "asc" : "desc" };
    }
    this._render();
  }

  _sortedRows(rows) {
    const copy = [...rows];
    const direction = this._sort.direction === "asc" ? 1 : -1;
    const collator = new Intl.Collator("de-AT", { numeric: true, sensitivity: "base" });

    if (this._sort.key === "default") {
      return copy.sort((a, b) => {
        const groupCompare = this._deviceGroup(a.name) - this._deviceGroup(b.name);
        return groupCompare || collator.compare(a.name, b.name);
      });
    }

    return copy.sort((a, b) => {
      if (this._sort.key === "name") {
        return direction * collator.compare(a.name, b.name);
      }
      return direction * ((a[this._sort.key] || 0) - (b[this._sort.key] || 0));
    });
  }

  _deviceGroup(name) {
    return /\((K|EG|OG)\)\s*$/i.test(name || "") ? 1 : 0;
  }

  _percent(value, total) {
    return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  }

  _formatValue(value, percent) {
    return `${this._format(value)} kWh <span class="muted">${this._format(percent)} %</span>`;
  }

  _format(value) {
    return this._number.format(Number.isFinite(value) ? value : 0);
  }

  _friendlyName(entityId) {
    if (!entityId || !this._hass || !this._hass.states || !this._hass.states[entityId]) {
      return null;
    }
    return this._hass.states[entityId].attributes.friendly_name || entityId;
  }

  _unique(values) {
    return [...new Set(values)];
  }

  _uniqueDevices(devices) {
    const seen = new Set();
    return devices.filter((device) => {
      if (seen.has(device.statisticId)) {
        return false;
      }
      seen.add(device.statisticId);
      return true;
    });
  }

  _escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  _styles() {
    const colors = this._config.colors || {};
    return `
      :host {
        display: block;
        --energy-origin-pv: ${colors.pv || "#43a047"};
        --energy-origin-battery: ${colors.battery || "#fbc02d"};
        --energy-origin-grid: ${colors.grid || "#e53935"};
      }

      .content {
        padding: 0 16px 16px;
      }

      .state,
      .error,
      .summary {
        color: var(--secondary-text-color);
        padding: 8px 0;
      }

      .error {
        color: var(--error-color, #db4437);
      }

      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.92rem;
      }

      th,
      td {
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        padding: 10px 8px;
        text-align: right;
        vertical-align: middle;
      }

      th:first-child,
      td:first-child {
        text-align: left;
      }

      th {
        color: var(--secondary-text-color);
        font-weight: 500;
        white-space: nowrap;
      }

      th button {
        appearance: none;
        background: none;
        border: 0;
        color: inherit;
        cursor: pointer;
        font: inherit;
        padding: 0;
      }

      .name {
        color: var(--primary-text-color);
        font-weight: 500;
        max-width: 220px;
      }

      .muted {
        color: var(--secondary-text-color);
        display: block;
        font-size: 0.82rem;
        margin-top: 2px;
      }

      .bar {
        background: var(--divider-color, rgba(0, 0, 0, 0.12));
        border-radius: 6px;
        display: flex;
        height: 18px;
        min-width: 150px;
        overflow: hidden;
        width: 100%;
      }

      .bar span {
        display: block;
        min-width: 0;
      }

      .bar .pv {
        background: var(--energy-origin-pv);
      }

      .bar .battery {
        background: var(--energy-origin-battery);
      }

      .bar .grid {
        background: var(--energy-origin-grid);
      }

      @media (max-width: 680px) {
        table,
        thead,
        tbody,
        tr,
        th,
        td {
          display: block;
        }

        thead {
          display: none;
        }

        tr {
          border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
          padding: 10px 0;
        }

        td {
          border: 0;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 0;
          text-align: right;
        }

        td::before {
          color: var(--secondary-text-color);
          content: attr(data-label);
          flex: 0 0 auto;
          text-align: left;
        }

        td.name {
          display: block;
          font-size: 1rem;
          max-width: none;
          padding-bottom: 8px;
          text-align: left;
        }

        td.name::before {
          content: "";
        }

        .bar {
          min-width: 180px;
        }
      }
    `;
  }
}

customElements.define("energy-origin-table", EnergyOriginTable);
