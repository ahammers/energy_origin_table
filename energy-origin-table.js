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
        deviceStatisticModes: this._config.device_statistic_modes || this._config.statistic_modes || {},
        debug: Boolean(this._config.debug),
        debugSeries: this._config.debug_series || this._config.debugSeries || [],
        relativeBarWidths: this._useRelativeBarWidths(),
        donuts: this._enabledDonutMetrics(),
        showTable: this._showTable(),
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
      const debugInfo = this._config.debug
        ? this._buildDebugInfo(resolved, statsIds, metadata, raw, series, result, start, end)
        : null;

      this._state = {
        status: "ready",
        ...result,
        resolved,
        debugInfo,
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
      debugEnergyPreferences: dashboard,
      debugAutomaticConfig: automatic,
      debugManualConfig: manual,
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
              includedInStatisticId: device.included_in_stat || device.includedInStatisticId || null,
              level: Number(device.level) || null,
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
          includedInStatisticId: device.included_in_stat || null,
          level: device.included_in_stat ? 2 : 1,
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
      types: ["sum", "state"],
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
        ? [...points]
            .filter((point) => Number.isFinite(Number(point.sum)) || Number.isFinite(Number(point.state)))
            .sort((a, b) => this._pointTime(a) - this._pointTime(b))
        : [];
      const unit = unitOverride || this._unitFor(statisticId, sorted, metadata);
      const cleanCounterOutliers = this._stateClassFor(statisticId) === "total";
      const sumDelta = this._buildFieldDeltaValues(sorted, "sum", unit, cleanCounterOutliers);
      const stateDelta = this._buildFieldDeltaValues(sorted, "state", unit, cleanCounterOutliers);

      series[statisticId] = {
        values: sumDelta.values.size ? sumDelta.values : stateDelta.values,
        sumValues: sumDelta.values,
        stateValues: stateDelta.values,
        unit,
        cleanCounterOutliers,
        droppedOutliers: {
          sum: sumDelta.droppedOutliers,
          state: stateDelta.droppedOutliers,
        },
        fullDebug: {
          sum: sumDelta.debug,
          state: stateDelta.debug,
        },
      };
    }
    return series;
  }

  _buildFieldDeltaValues(points, field, unit, cleanCounterOutliers) {
    const values = new Map();
    const cleaned = cleanCounterOutliers ? this._removeCounterOutliers(points, field) : points;

    for (let index = 1; index < cleaned.length; index += 1) {
      const previous = Number(cleaned[index - 1][field]);
      const current = Number(cleaned[index][field]);
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
      const targetKeys = this._interpolatedHourKeys(cleaned[index - 1], cleaned[index]);
      const convertedDelta = this._convertToKwh(delta, unit);
      const valuePerHour = targetKeys.length ? convertedDelta / targetKeys.length : convertedDelta;
      for (const key of targetKeys.length ? targetKeys : [this._hourKey(this._pointTime(cleaned[index]))]) {
        values.set(key, (values.get(key) || 0) + valuePerHour);
      }
    }

    return {
      values,
      droppedOutliers: points.length - cleaned.length,
      debug: {
        cleanedPoints: cleaned,
        deltaValues: values,
      },
    };
  }

  _removeCounterOutliers(points, field) {
    const backwardThreshold = Number(this._config.counter_drop_threshold_kwh || 0.05);
    const forwardThreshold = Number(this._config.counter_spike_threshold_kwh || 25);
    const cleaned = [];
    let lastAccepted = null;

    for (const point of points) {
      const value = Number(point[field]);
      if (!Number.isFinite(value)) {
        continue;
      }

      if (lastAccepted != null) {
        const delta = value - lastAccepted;
        const lastTime = this._pointTime(cleaned[cleaned.length - 1]);
        const currentTime = this._pointTime(point);
        const hours = Math.max(1, Math.round((currentTime - lastTime) / (60 * 60 * 1000)));
        if (delta < -backwardThreshold || delta > forwardThreshold * hours) {
          continue;
        }
      }

      cleaned.push(point);
      lastAccepted = value;
    }

    return cleaned;
  }

  _interpolatedHourKeys(previousPoint, currentPoint) {
    const keys = [];
    const previousTime = this._pointTime(previousPoint);
    const currentTime = this._pointTime(currentPoint);
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime <= previousTime) {
      return keys;
    }

    const cursor = new Date(previousTime);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(cursor.getHours() + 1);
    const end = new Date(currentTime);
    end.setMinutes(0, 0, 0);

    while (cursor <= end) {
      keys.push(cursor.toISOString());
      cursor.setHours(cursor.getHours() + 1);
    }

    return keys;
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
      pv: this._seriesValues(series, resolved.sources.pv, "source"),
      gridImport: this._seriesValues(series, resolved.sources.gridImport, "source"),
      gridExport: this._seriesValues(series, resolved.sources.gridExport, "source"),
      batteryDischarge: this._seriesValues(series, resolved.sources.batteryDischarge, "source"),
      batteryCharge: this._seriesValues(series, resolved.sources.batteryCharge, "source"),
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
      const deviceEntry = this._seriesEntry(series, device.statisticId);
      const statisticMode = this._seriesMode(deviceEntry, "device", device.statisticId);
      const deviceValues = this._seriesValues(series, device.statisticId, "device");
      const totals = { pv: 0, battery: 0, grid: 0, total: 0, hours: 0 };

      for (const [key, shares] of sharesByHour.entries()) {
        const consumption = deviceValues.get(key);
        if (!Number.isFinite(consumption)) {
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
        statisticMode,
        level: this._deviceLevel(device),
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
      stateFallbackRows: rows.filter((row) => row.statisticMode === "state").length,
      sourceDebug: this._sourceDebug(sourceValues, sharesByHour, hourKeys),
    };
  }

  _sourceDebug(sourceValues, sharesByHour, hourKeys) {
    const totals = {
      pvProduced: this._sumMatchingHours(sourceValues.pv, hourKeys),
      gridImport: this._sumMatchingHours(sourceValues.gridImport, hourKeys),
      gridExport: this._sumMatchingHours(sourceValues.gridExport, hourKeys),
      batteryDischarge: this._sumMatchingHours(sourceValues.batteryDischarge, hourKeys),
      batteryCharge: this._sumMatchingHours(sourceValues.batteryCharge, hourKeys),
      pvDirect: 0,
      sourceTotal: 0,
    };

    const shares = {
      pvMin: null,
      pvMax: null,
      batteryMin: null,
      batteryMax: null,
      gridMin: null,
      gridMax: null,
    };

    for (const [key, share] of sharesByHour.entries()) {
      const pvProduced = sourceValues.pv.get(key) || 0;
      const gridImport = sourceValues.gridImport.get(key) || 0;
      const gridExport = sourceValues.gridExport.get(key) || 0;
      const batteryDischarge = sourceValues.batteryDischarge.get(key) || 0;
      const batteryCharge = sourceValues.batteryCharge.get(key) || 0;
      const pvDirect = Math.max(pvProduced - gridExport - batteryCharge, 0);

      totals.pvDirect += pvDirect;
      totals.sourceTotal += pvDirect + batteryDischarge + gridImport;
      this._minMax(shares, "pv", share.pv);
      this._minMax(shares, "battery", share.battery);
      this._minMax(shares, "grid", share.grid);
    }

    return {
      totals: this._roundObject(totals),
      shares: this._roundObject(shares),
    };
  }

  _sumMatchingHours(values, hourKeys) {
    let total = 0;
    for (const key of hourKeys) {
      const value = values && values.get ? values.get(key) : null;
      if (Number.isFinite(value)) {
        total += value;
      }
    }
    return total;
  }

  _minMax(target, prefix, value) {
    if (!Number.isFinite(value)) {
      return;
    }
    const minKey = `${prefix}Min`;
    const maxKey = `${prefix}Max`;
    target[minKey] = target[minKey] == null ? value : Math.min(target[minKey], value);
    target[maxKey] = target[maxKey] == null ? value : Math.max(target[maxKey], value);
  }

  _seriesEntry(series, statisticId) {
    return statisticId && series[statisticId] ? series[statisticId] : null;
  }

  _seriesValues(series, statisticId, role) {
    const entry = this._seriesEntry(series, statisticId);
    if (!entry) {
      return new Map();
    }
    return this._seriesMode(entry, role, statisticId) === "state" ? entry.stateValues : entry.values;
  }

  _seriesMode(entry, role, statisticId) {
    if (!entry) {
      return "none";
    }

    if (role === "source") {
      return entry.sumValues && entry.sumValues.size ? "sum" : "state";
    }

    const configuredMode = this._configuredStatisticMode(statisticId);
    if (configuredMode === "sum" || configuredMode === "state") {
      return configuredMode;
    }

    const stateClass = this._stateClassFor(statisticId);
    if (stateClass === "total") {
      return "state";
    }
    if (stateClass === "total_increasing") {
      return "sum";
    }

    if (!entry.stateValues || !entry.stateValues.size) {
      return "sum";
    }
    if (!entry.sumValues || !entry.sumValues.size) {
      return "state";
    }

    const sumTotal = this._mapTotal(entry.sumValues);
    const stateTotal = this._mapTotal(entry.stateValues);
    const threshold = Number(this._config.sum_state_ratio_threshold || 3);
    if (stateTotal > 0 && sumTotal > stateTotal * threshold) {
      return "state";
    }
    return "sum";
  }

  _configuredStatisticMode(statisticId) {
    const modes = this._config.device_statistic_modes || this._config.statistic_modes || {};
    const mode = modes && statisticId ? String(modes[statisticId] || "").toLowerCase() : "";
    return ["sum", "state", "auto"].includes(mode) ? mode : "auto";
  }

  _stateClassFor(statisticId) {
    if (!statisticId || !this._hass || !this._hass.states || !this._hass.states[statisticId]) {
      return "";
    }
    return String(this._hass.states[statisticId].attributes.state_class || "").toLowerCase();
  }

  _mapTotal(values) {
    let total = 0;
    for (const value of values.values()) {
      if (Number.isFinite(value)) {
        total += value;
      }
    }
    return total;
  }

  _buildDebugInfo(resolved, statsIds, metadata, raw, series, result, start, end) {
    const idsByRole = {
      sources: resolved.sources,
      devices: resolved.devices.map((device) => ({
        name: device.name,
        statisticId: device.statisticId,
      })),
    };

    const seriesInfo = {};
    for (const statisticId of statsIds) {
      const entry = this._seriesEntry(series, statisticId);
      seriesInfo[statisticId] = {
        entity: this._entityDebug(statisticId),
        metadata: metadata[statisticId] || null,
        unitUsedByCard: entry ? entry.unit : null,
        cleanCounterOutliers: entry ? entry.cleanCounterOutliers : false,
        droppedOutliers: entry ? entry.droppedOutliers : null,
        modeAsSource: entry ? this._seriesMode(entry, "source", statisticId) : "none",
        modeAsDevice: entry ? this._seriesMode(entry, "device", statisticId) : "none",
        totalsFromDeltas: entry
          ? this._roundObject({
              sum: this._mapTotal(entry.sumValues),
              state: this._mapTotal(entry.stateValues),
              selectedAsDevice: this._mapTotal(this._seriesValues(series, statisticId, "device")),
              selectedAsSource: this._mapTotal(this._seriesValues(series, statisticId, "source")),
            })
          : null,
        rawPoints: this._rawPointDebug(raw.data[statisticId]),
        fullSeries: this._shouldDebugSeries(statisticId)
          ? this._fullSeriesDebug(statisticId, raw.data[statisticId], entry)
          : null,
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      cardConfig: {
        days: Number(this._config.days),
        use_energy_dashboard: this._config.use_energy_dashboard !== false,
        device_statistic_modes: this._config.device_statistic_modes || this._config.statistic_modes || {},
      },
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      recorderRequest: {
        normalizedToKwh: raw.normalizedToKwh,
        requestedTypes: ["sum", "state"],
      },
      resolved: idsByRole,
      energyPreferences: resolved.debugEnergyPreferences || null,
      automaticConfig: resolved.debugAutomaticConfig || null,
      manualConfig: resolved.debugManualConfig || null,
      sourceDebug: result.sourceDebug,
      rows: result.rows.map((row) => this._roundObject({
        name: row.name,
        statisticId: row.statisticId,
        statisticMode: row.statisticMode,
        level: row.level,
        total: row.total,
        pv: row.pv,
        battery: row.battery,
        grid: row.grid,
        hours: row.hours,
      })),
      series: seriesInfo,
    };
  }

  _shouldDebugSeries(statisticId) {
    const configured = this._config.debug_series || this._config.debugSeries || [];
    return configured === true || (Array.isArray(configured) && configured.includes(statisticId));
  }

  _fullSeriesDebug(statisticId, rawPoints, entry) {
    const raw = Array.isArray(rawPoints) ? rawPoints : [];
    const cleanedStateKeys = new Set((entry && entry.fullDebug && entry.fullDebug.state.cleanedPoints
      ? entry.fullDebug.state.cleanedPoints
      : []).map((point) => this._pointIdentity(point)));
    const cleanedSumKeys = new Set((entry && entry.fullDebug && entry.fullDebug.sum.cleanedPoints
      ? entry.fullDebug.sum.cleanedPoints
      : []).map((point) => this._pointIdentity(point)));

    return {
      statisticId,
      raw: raw.map((point) => ({
        time: new Date(this._pointTime(point)).toISOString(),
        sum: this._debugNumber(point.sum),
        state: this._debugNumber(point.state),
        keptForSum: cleanedSumKeys.has(this._pointIdentity(point)),
        keptForState: cleanedStateKeys.has(this._pointIdentity(point)),
      })),
      selectedDeltaByHour: this._mapToDebugArray(this._seriesValues({ [statisticId]: entry }, statisticId, "device")),
      sumDeltaByHour: this._mapToDebugArray(entry ? entry.sumValues : new Map()),
      stateDeltaByHour: this._mapToDebugArray(entry ? entry.stateValues : new Map()),
    };
  }

  _pointIdentity(point) {
    return `${this._pointTime(point)}|${point.sum}|${point.state}`;
  }

  _mapToDebugArray(values) {
    return [...values.entries()].map(([time, value]) => ({
      time,
      value: this._debugNumber(value),
    }));
  }

  _entityDebug(entityId) {
    const state = entityId && this._hass && this._hass.states ? this._hass.states[entityId] : null;
    if (!state) {
      return null;
    }

    return {
      entityId,
      state: state.state,
      attributes: {
        friendly_name: state.attributes.friendly_name,
        device_class: state.attributes.device_class,
        state_class: state.attributes.state_class,
        unit_of_measurement: state.attributes.unit_of_measurement,
      },
    };
  }

  _rawPointDebug(points) {
    const cleaned = Array.isArray(points)
      ? points.map((point) => ({
          start: point.start || point.start_time || null,
          end: point.end || point.end_time || null,
          sum: this._debugNumber(point.sum),
          state: this._debugNumber(point.state),
          unit: point.unit || point.unit_of_measurement || null,
        }))
      : [];

    return {
      count: cleaned.length,
      first: cleaned.slice(0, 3),
      last: cleaned.slice(Math.max(0, cleaned.length - 3)),
    };
  }

  _roundObject(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this._roundObject(item));
    }
    if (value && typeof value === "object") {
      const rounded = {};
      for (const [key, nested] of Object.entries(value)) {
        rounded[key] = this._roundObject(nested);
      }
      return rounded;
    }
    return this._debugNumber(value);
  }

  _debugNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return value == null ? null : value;
    }
    return Math.round(number * 1000000) / 1000000;
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
      body = this._renderReady();
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

  _renderReady() {
    return `
      ${this._renderDonuts()}
      ${this._showTable() ? this._renderTable() : ""}
      ${!this._showTable() ? this._renderDebug() : ""}
    `;
  }

  _renderTable() {
    const rows = this._sortedRows(this._state.rows);
    const maxTotal = Math.max(...rows.map((row) => row.total || 0), 0);
    const summary = `Auswertbar: ${this._state.evaluableHours} von ${this._state.hourCount} Stunden`;
    const missing = this._state.missingSourceHours ? `; nicht auswertbar: ${this._state.missingSourceHours}` : "";
    const fallback = this._state.stateFallbackRows
      ? `; ${this._state.stateFallbackRows} Ger\u00e4te \u00fcber Zustandsdifferenz`
      : "";

    return `
      <div class="summary">${summary}${missing}${fallback}</div>
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
          ${rows.map((row, index) => this._renderRow(row, maxTotal, index, rows)).join("")}
        </tbody>
      </table>
      ${this._renderDebug()}
    `;
  }

  _renderDonuts() {
    const metrics = this._enabledDonutMetrics();
    if (!metrics.length || !this._state.rows || !this._state.rows.length) {
      return "";
    }

    const rows = this._sortedRows(this._state.rows);
    const colorMap = this._rowColorMap(rows);
    return `
      <div class="donut-layout">
        <div class="donuts">
          ${metrics.map((metric) => this._renderDonut(metric, rows, colorMap)).join("")}
        </div>
        ${this._renderDonutLegend(rows, colorMap)}
      </div>
    `;
  }

  _renderDonut(metric, rows, colorMap) {
    const label = this._metricLabel(metric);
    const level1 = rows.filter((row) => (row.level || 1) === 1);
    const level2 = rows.filter((row) => (row.level || 1) > 1);
    const level1Total = this._metricTotal(level1, metric);
    const level2Total = this._metricTotal(level2, metric);

    return `
      <section class="donut-card">
        <div class="donut-title">${this._escape(label)}</div>
        <svg class="donut-svg" viewBox="0 0 240 240" role="img" aria-label="${this._escape(label)}">
          ${this._renderDonutRing(level2, metric, 82, 110, "Ebene 2", colorMap)}
          ${this._renderDonutRing(level1, metric, 45, 75, "Ebene 1", colorMap)}
          <circle cx="120" cy="120" r="38" class="donut-hole"></circle>
          <text x="120" y="116" class="donut-center-title">${this._escape(this._metricShortLabel(metric))}</text>
          <text x="120" y="136" class="donut-center-value">${this._escape(this._format(level1Total))} kWh</text>
        </svg>
        <div class="donut-stats">
          <span>Ebene 1: ${this._format(level1Total)} kWh</span>
          <span>Ebene 2: ${this._format(level2Total)} kWh</span>
        </div>
      </section>
    `;
  }

  _renderDonutRing(rows, metric, innerRadius, outerRadius, levelLabel, colorMap) {
    const values = rows
      .map((row, index) => ({
        row,
        index,
        value: Math.max(0, Number(row[metric]) || 0),
      }))
      .filter((item) => item.value > 0);
    const total = values.reduce((sum, item) => sum + item.value, 0);

    if (total <= 0) {
      return `<circle cx="120" cy="120" r="${(innerRadius + outerRadius) / 2}" class="donut-empty" stroke-width="${outerRadius - innerRadius}"></circle>`;
    }

    let startAngle = -90;
    return values.map((item) => {
      const sweep = (item.value / total) * 360;
      const endAngle = startAngle + sweep;
      const path = this._annularSectorPath(120, 120, innerRadius, outerRadius, startAngle, endAngle);
      const percent = this._percent(item.value, total);
      const color = this._rowColor(item.row, item.index, colorMap);
      const title = `${levelLabel}: ${item.row.name} - ${this._format(item.value)} kWh (${this._format(percent)} %)`;
      startAngle = endAngle;
      return `<path d="${path}" fill="${color}"><title>${this._escape(title)}</title></path>`;
    }).join("");
  }

  _renderDonutLegend(rows, colorMap) {
    const levels = [
      { level: 1, label: "Ebene 1" },
      { level: 2, label: "Ebene 2" },
    ];

    return `
      <aside class="donut-legend" aria-label="Donut-Legende">
        ${levels.map((group) => {
          const groupRows = rows.filter((row) => (row.level || 1) === group.level);
          if (!groupRows.length) {
            return "";
          }
          return `
            <div class="legend-group">
              <div class="legend-title">${group.label}</div>
              ${groupRows.map((row, index) => `
                <div class="legend-item">
                  <span class="legend-swatch" style="background:${this._rowColor(row, index, colorMap)}"></span>
                  <span class="legend-name">${this._escape(row.name)}</span>
                </div>
              `).join("")}
            </div>
          `;
        }).join("")}
      </aside>
    `;
  }

  _annularSectorPath(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
    const adjustedEnd = endAngle - startAngle >= 359.99 ? startAngle + 359.99 : endAngle;
    const largeArc = adjustedEnd - startAngle > 180 ? 1 : 0;
    const outerStart = this._polarToCartesian(cx, cy, outerRadius, startAngle);
    const outerEnd = this._polarToCartesian(cx, cy, outerRadius, adjustedEnd);
    const innerEnd = this._polarToCartesian(cx, cy, innerRadius, adjustedEnd);
    const innerStart = this._polarToCartesian(cx, cy, innerRadius, startAngle);

    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      "Z",
    ].join(" ");
  }

  _polarToCartesian(cx, cy, radius, angleDegrees) {
    const angleRadians = (angleDegrees * Math.PI) / 180;
    return {
      x: this._debugNumber(cx + radius * Math.cos(angleRadians)),
      y: this._debugNumber(cy + radius * Math.sin(angleRadians)),
    };
  }

  _renderDebug() {
    if (!this._config.debug || !this._state.debugInfo) {
      return "";
    }

    const json = JSON.stringify(this._state.debugInfo, null, 2);
    return `
      <details class="debug" open>
        <summary>Debug-Rohdaten fuer Codex</summary>
        <div class="debug-note">Bitte den folgenden JSON-Block kopieren und hier einfuegen.</div>
        <textarea readonly>${this._escape(json)}</textarea>
      </details>
    `;
  }

  _header(key, label) {
    const active = this._sort.key === key;
    const marker = active ? (this._sort.direction === "asc" ? " &#9650;" : " &#9660;") : "";
    return `<th><button type="button" data-sort="${key}">${label}${marker}</button></th>`;
  }

  _renderRow(row, maxTotal, index, rows) {
    const pvPercent = this._percent(row.pv, row.total);
    const batteryPercent = this._percent(row.battery, row.total);
    const gridPercent = this._percent(row.grid, row.total);
    const relativeBarWidth = this._useRelativeBarWidths()
      ? this._relativeBarWidth(row.total, maxTotal)
      : 100;
    const previous = index > 0 ? rows[index - 1] : null;
    const levelBreak = previous && previous.level !== row.level ? " level-break" : "";
    const title = `PV ${this._format(row.pv)} kWh (${this._format(pvPercent)} %), Batterie ${this._format(row.battery)} kWh (${this._format(batteryPercent)} %), Netz ${this._format(row.grid)} kWh (${this._format(gridPercent)} %)`;

    return `
      <tr class="level-${row.level || 1}${levelBreak}">
        <td class="name" title="${this._escape(row.statisticId)}">${this._escape(row.name)}</td>
        <td data-label="Gesamt">${this._format(row.total)} kWh</td>
        <td data-label="Herkunft">
          <div class="bar-track">
            <div class="bar" style="width:${relativeBarWidth}%" title="${this._escape(title)}">
              <span class="pv" style="width:${pvPercent}%"></span>
              <span class="battery" style="width:${batteryPercent}%"></span>
              <span class="grid" style="width:${gridPercent}%"></span>
            </div>
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
        const levelCompare = (a.level || 1) - (b.level || 1);
        return levelCompare || collator.compare(a.name, b.name);
      });
    }

    return copy.sort((a, b) => {
      const levelCompare = (a.level || 1) - (b.level || 1);
      if (levelCompare) {
        return levelCompare;
      }
      if (this._sort.key === "name") {
        return direction * collator.compare(a.name, b.name);
      }
      return direction * ((a[this._sort.key] || 0) - (b[this._sort.key] || 0));
    });
  }

  _deviceLevel(device) {
    if (Number(device.level) > 0) {
      return Number(device.level);
    }
    if (device.includedInStatisticId) {
      return 2;
    }
    return /\((K|EG|OG)\)\s*$/i.test(device.name || "") ? 2 : 1;
  }

  _percent(value, total) {
    return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  }

  _relativeBarWidth(value, maxTotal) {
    if (!maxTotal || maxTotal <= 0 || !Number.isFinite(value)) {
      return 0;
    }
    const width = (value / maxTotal) * 100;
    return value > 0 ? Math.max(2, Math.min(100, width)) : 0;
  }

  _enabledDonutMetrics() {
    const configured = this._config.donuts || this._config.show_donuts || this._config.donut_metrics || [];
    const all = ["total", "pv", "battery", "grid"];

    if (configured === true || String(configured).toLowerCase() === "all") {
      return all;
    }
    if (Array.isArray(configured)) {
      return configured.map((metric) => this._normalizeMetric(metric)).filter((metric) => all.includes(metric));
    }
    if (configured && typeof configured === "object") {
      return all.filter((metric) => this._isEnabled(configured[metric]));
    }
    return [];
  }

  _normalizeMetric(metric) {
    const normalized = String(metric || "").toLowerCase();
    if (["pv", "solar"].includes(normalized)) {
      return "pv";
    }
    if (["battery", "batterie", "akku"].includes(normalized)) {
      return "battery";
    }
    if (["grid", "netz"].includes(normalized)) {
      return "grid";
    }
    if (["total", "gesamt"].includes(normalized)) {
      return "total";
    }
    return normalized;
  }

  _showTable() {
    return !this._isDisabled(this._config.show_table) && !this._isDisabled(this._config.table);
  }

  _useRelativeBarWidths() {
    return this._isEnabled(this._config.relative_bar_widths)
      || this._isEnabled(this._config.relativeBarWidths)
      || this._config.bar_width_mode === "relative"
      || this._config.barWidthMode === "relative";
  }

  _isEnabled(value) {
    return value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "yes";
  }

  _isDisabled(value) {
    return value === false || String(value).toLowerCase() === "false" || String(value).toLowerCase() === "no";
  }

  _metricLabel(metric) {
    return {
      total: "Gesamtverbrauch",
      pv: "PV-Verbrauch",
      battery: "Batterie-Verbrauch",
      grid: "Netz-Verbrauch",
    }[metric] || metric;
  }

  _metricShortLabel(metric) {
    return {
      total: "Gesamt",
      pv: "PV",
      battery: "Batterie",
      grid: "Netz",
    }[metric] || metric;
  }

  _metricTotal(rows, metric) {
    return rows.reduce((sum, row) => sum + Math.max(0, Number(row[metric]) || 0), 0);
  }

  _rowColorMap(rows) {
    const level1Palette = [
      "#2563eb",
      "#16a34a",
      "#dc2626",
      "#ca8a04",
      "#7c3aed",
      "#0891b2",
      "#db2777",
      "#65a30d",
    ];
    const level2Palette = [
      "#ea580c",
      "#4f46e5",
      "#0d9488",
      "#9333ea",
      "#be123c",
      "#0284c7",
      "#a16207",
      "#15803d",
    ];

    const map = new Map();
    const byLevel = [
      { rows: rows.filter((row) => (row.level || 1) === 1), palette: level1Palette },
      { rows: rows.filter((row) => (row.level || 1) > 1), palette: level2Palette },
    ];

    for (const group of byLevel) {
      group.rows.forEach((row, index) => {
        map.set(row.statisticId || row.name, group.palette[index % group.palette.length]);
      });
    }
    return map;
  }

  _rowColor(row, index, colorMap) {
    const key = row.statisticId || row.name;
    if (colorMap && colorMap.has(key)) {
      return colorMap.get(key);
    }
    const fallback = (row.level || 1) === 1 ? "#2563eb" : "#ea580c";
    return fallback;
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

      .donut-layout {
        align-items: start;
        display: grid;
        gap: 18px;
        grid-template-columns: minmax(240px, 1fr) minmax(220px, 300px);
        margin-bottom: 16px;
      }

      .donuts {
        display: grid;
        gap: 14px;
        grid-template-columns: 1fr;
      }

      .donut-card {
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        padding-top: 12px;
        text-align: center;
      }

      .donut-title {
        color: var(--primary-text-color);
        font-weight: 600;
        margin-bottom: 6px;
      }

      .donut-svg {
        display: block;
        height: auto;
        margin: 0 auto;
        max-width: 240px;
        width: 100%;
      }

      .donut-hole {
        fill: var(--card-background-color, #fff);
      }

      .donut-empty {
        fill: none;
        stroke: var(--divider-color, rgba(0, 0, 0, 0.12));
      }

      .donut-center-title,
      .donut-center-value {
        dominant-baseline: middle;
        fill: var(--primary-text-color);
        font-family: inherit;
        text-anchor: middle;
      }

      .donut-center-title {
        font-size: 14px;
        font-weight: 700;
      }

      .donut-center-value {
        fill: var(--secondary-text-color);
        font-size: 11px;
      }

      .donut-stats {
        color: var(--secondary-text-color);
        display: flex;
        flex-wrap: wrap;
        font-size: 0.82rem;
        gap: 8px 12px;
        justify-content: center;
        line-height: 1.35;
        margin-top: 4px;
      }

      .donut-legend {
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        padding-top: 12px;
      }

      .legend-group + .legend-group {
        margin-top: 18px;
      }

      .legend-title {
        color: var(--primary-text-color);
        font-weight: 600;
        margin-bottom: 8px;
      }

      .legend-item {
        align-items: center;
        display: grid;
        gap: 8px;
        grid-template-columns: 12px 1fr;
        min-height: 24px;
      }

      .legend-swatch {
        border-radius: 2px;
        display: inline-block;
        height: 12px;
        width: 12px;
      }

      .legend-name {
        color: var(--primary-text-color);
        font-size: 0.86rem;
        overflow-wrap: anywhere;
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

      tr.level-2 .name {
        font-weight: 500;
        padding-left: 22px;
      }

      tr.level-break td {
        border-top: 2px solid var(--divider-color, rgba(0, 0, 0, 0.18));
      }

      .muted {
        color: var(--secondary-text-color);
        display: block;
        font-size: 0.82rem;
        margin-top: 2px;
      }

      .bar-track {
        min-width: 150px;
        width: 100%;
      }

      .bar {
        background: var(--divider-color, rgba(0, 0, 0, 0.12));
        border-radius: 6px;
        display: flex;
        height: 18px;
        min-width: 0;
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

      .debug {
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        margin-top: 16px;
        padding-top: 12px;
      }

      .debug summary {
        color: var(--primary-text-color);
        cursor: pointer;
        font-weight: 500;
      }

      .debug-note {
        color: var(--secondary-text-color);
        font-size: 0.86rem;
        margin: 8px 0;
      }

      .debug textarea {
        background: var(--code-editor-background-color, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        border-radius: 6px;
        box-sizing: border-box;
        color: var(--primary-text-color);
        font-family: var(--code-font-family, monospace);
        font-size: 0.78rem;
        min-height: 360px;
        padding: 8px;
        resize: vertical;
        width: 100%;
      }

      @media (max-width: 680px) {
        .donut-layout {
          grid-template-columns: 1fr;
        }

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

        .bar-track {
          min-width: 180px;
        }

        tr.level-2 .name {
          padding-left: 0;
        }
      }
    `;
  }
}

customElements.define("energy-origin-table", EnergyOriginTable);
