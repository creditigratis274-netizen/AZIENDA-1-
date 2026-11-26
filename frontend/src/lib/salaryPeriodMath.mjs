export function monthSalaryWeeks(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) return [];

  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0));
  if (!Number.isFinite(monthStart.getTime()) || !Number.isFinite(monthEnd.getTime())) return [];

  const firstMonday = new Date(monthStart);
  const mondayOffset = (firstMonday.getUTCDay() + 6) % 7;
  if (mondayOffset !== 0) {
    firstMonday.setUTCDate(firstMonday.getUTCDate() - mondayOffset);
  }

  const weeks = [];
  for (let monday = new Date(firstMonday); monday <= monthEnd;) {
    const saturday = new Date(monday);
    saturday.setUTCDate(saturday.getUTCDate() + 5);

    const overlapStart = monday > monthStart ? monday : monthStart;
    const overlapEnd = saturday < monthEnd ? saturday : monthEnd;
    if (overlapStart <= overlapEnd) {
      weeks.push({
        start: overlapStart.toISOString().slice(0, 10),
        end: overlapEnd.toISOString().slice(0, 10),
      });
    }

    monday.setUTCDate(monday.getUTCDate() + 7);
  }
  return weeks;
}
