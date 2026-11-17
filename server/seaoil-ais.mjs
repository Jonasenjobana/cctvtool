function sourceTime(value, offsetMinutes) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return null;
  return new Date(calendar.getTime() - offsetMinutes * 60000).toISOString();
}

const positive = value => Number.isFinite(value) && value > 0 ? value : null;

export function decodeSeaoilAis(packet, config) {
  if (packet?.api !== 1) return null;
  if (!Array.isArray(packet.datas)) throw new Error('AIS 批次缺少 datas 数组');
  let invalidCount = 0;
  const targets = [];
  for (const row of packet.datas) {
    const mmsi = typeof row?.mmsi === 'string' ? row.mmsi.trim() : '';
    const time = sourceTime(row?.date, config.timeOffsetMinutes);
    if (!/^\d{9}$/.test(mmsi) || mmsi === '000000000' || !time
      || !Number.isFinite(row.lng) || Math.abs(row.lng) > 180 || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90) {
      invalidCount++;
      continue;
    }
    targets.push({ mmsi, time, longitude: row.lng, latitude: row.lat,
      heading: Number.isFinite(row.heading) && row.heading >= 0 && row.heading < 360 ? row.heading : null,
      cog: Number.isFinite(row.cog) && row.cog >= 0 && row.cog < 360 ? row.cog : null,
      length: positive(row.shipLength), width: positive(row.shipWidth),
      speed: Number.isFinite(row.speed) && row.speed >= 0 && row.speed < 102.3 ? row.speed : null });
  }
  return { targets, invalidCount };
}
