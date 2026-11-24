/**
 * Urdu strings (right-to-left). DRAFT: needs review by a native speaker before release
 * (PROGRESS.md). Missing keys fall back to English. Used by: i18n/index.tsx.
 */
import type { Messages } from './en';
import { urPhase4 } from './ur.phase4';

export const ur: Messages = {
  'common.loading': 'لوڈ ہو رہا ہے…',
  'common.save': 'محفوظ کریں',
  'common.cancel': 'منسوخ',
  'common.confirm': 'تصدیق کریں',
  'common.back': 'واپس',
  'common.continue': 'جاری رکھیں',
  'common.close': 'بند کریں',
  'common.empty': 'یہاں ابھی کچھ نہیں',
  'common.retry': 'دوبارہ کوشش کریں',
  'auth.title': 'سائن ان',
  'auth.organisation': 'ادارے کا کوڈ',
  'auth.identifier': 'صارف نام یا ای میل',
  'auth.password': 'پاس ورڈ',
  'auth.signIn': 'سائن ان',
  'auth.usePhone': 'فون کوڈ سے سائن ان',
  'auth.usePassword': 'پاس ورڈ سے سائن ان',
  'auth.sendCode': 'کوڈ بھیجیں',
  'auth.code': 'کوڈ',
  'auth.forgot': 'پاس ورڈ بھول گئے؟',
  'auth.newPassword': 'نیا پاس ورڈ',
  'auth.currentPassword': 'موجودہ پاس ورڈ',
  'auth.changePassword': 'پاس ورڈ تبدیل کریں',
  'auth.verify': 'تصدیق',
  'auth.signOut': 'سائن آؤٹ',
  'shell.language': 'زبان',
  'shell.theme': 'تھیم',
  'shell.company': 'کمپنی',
  'shell.home': 'ہوم',
  ...urPhase4,
};
