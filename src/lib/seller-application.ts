import type { Prisma } from '@prisma/client';

/**
 * A seller's application exactly as they filled it in, for the administrators
 * (admin overview + admin console). Only the columns the application uses are
 * read — never the logo/banner image data or any payment-processor secret — so
 * listing many applications stays light.
 */
export const APPLICATION_SELECT = {
  id: true, userId: true, slug: true, name: true, description: true, location: true, phone: true,
  status: true, createdAt: true, applicationAt: true, applicationSignature: true,
  businessName: true, businessType: true, registrationNumber: true, taxNumber: true, idNumber: true,
  websiteOrSocial: true, ownsBrand: true,
  streetAddress: true, city: true, province: true, postalCode: true,
  bankName: true, bankAccountType: true, bankAccountNumber: true, bankBranchCode: true, bankAccountHolder: true,
  productCategories: true, sourcing: true, monthlyVolume: true, dispatchDays: true, returnsDays: true,
  confirmAge: true, confirmAccuracy: true, confirmTerms: true,
  user: { select: { id: true, email: true, name: true, createdAt: true } },
} satisfies Prisma.StoreSelect;

export type ApplicationRow = Prisma.StoreGetPayload<{ select: typeof APPLICATION_SELECT }>;

export function applicationView(s: ApplicationRow) {
  return {
    id: s.id, userId: s.userId, slug: s.slug, name: s.name, description: s.description,
    location: s.location, phone: s.phone, status: s.status,
    createdAt: s.createdAt.toISOString(), applicationAt: s.applicationAt?.toISOString() ?? null,
    owner: { id: s.user.id, email: s.user.email, name: s.user.name, memberSince: s.user.createdAt.toISOString() },
    business: {
      businessName: s.businessName, businessType: s.businessType, registrationNumber: s.registrationNumber,
      taxNumber: s.taxNumber, idNumber: s.idNumber, websiteOrSocial: s.websiteOrSocial, ownsBrand: s.ownsBrand,
    },
    address: { streetAddress: s.streetAddress, city: s.city, province: s.province, postalCode: s.postalCode },
    banking: {
      bankName: s.bankName, bankAccountType: s.bankAccountType, bankAccountNumber: s.bankAccountNumber,
      bankBranchCode: s.bankBranchCode, bankAccountHolder: s.bankAccountHolder,
    },
    operations: {
      productCategories: s.productCategories, sourcing: s.sourcing, monthlyVolume: s.monthlyVolume,
      dispatchDays: s.dispatchDays, returnsDays: s.returnsDays,
    },
    declarations: { confirmAge: s.confirmAge, confirmAccuracy: s.confirmAccuracy, confirmTerms: s.confirmTerms, signature: s.applicationSignature },
  };
}
