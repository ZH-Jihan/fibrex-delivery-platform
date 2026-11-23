// Synthetic platform-sheet details for web tests (row 4.8c): invented values only.
import type { SheetDetails } from '../performance/PlatformDetails';

/** A person the platform sheet has no row for. */
export const NO_SHEET: SheetDetails = {
  found: false,
  asOfDate: null,
  updatedAt: null,
  dayOff: { text: null, weekdays: [], onFiguresDate: false, onCallDate: false, notUpdated: false },
  dutyTime: { from: null, to: null, text: null, notUpdated: false },
  break: { from: null, to: null, text: null, notUpdated: false },
  zone: null,
  plate: null,
  vehicleType: null,
  skill: null,
  tags: null,
  contactNumber: null,
  company: null,
  cod: null,
  balance: null,
  notUpdatedFields: [],
};

/** A person with a full sheet row; `over` changes single parts. */
export const fullSheet = (over: Partial<SheetDetails> = {}): SheetDetails => ({
  ...NO_SHEET,
  found: true,
  asOfDate: '2026-11-22',
  updatedAt: '2026-11-23T04:05:00.000Z',
  dayOff: {
    text: 'Friday',
    weekdays: [5],
    onFiguresDate: false,
    onCallDate: false,
    notUpdated: false,
  },
  dutyTime: { from: '14:00', to: '02:00', text: null, notUpdated: false },
  break: { from: '16:00', to: '17:00', text: null, notUpdated: false },
  zone: 'North Gate',
  plate: '123456',
  vehicleType: 'Rider',
  skill: 'Express',
  tags: 'Night shift',
  cod: { amount: '125.5000', currency: 'QAR' },
  ...over,
});
