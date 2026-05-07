import type { ProductType, UserImageCategory, EligibilityResult, SelectionSummary } from "./types.js";

/**
 * Maps each product type to the required user image categories (in priority order).
 * First match wins — if the user has any of the listed categories, they're eligible.
 */
export const PRODUCT_TYPE_MAPPING: Record<ProductType, UserImageCategory[]> = {
  // Eyewear
  sunglasses:             ["male_face_closeup", "female_face_closeup", "child_face_closeup"],
  eyeglasses:             ["male_face_closeup", "female_face_closeup", "child_face_closeup"],
  // Clothing
  mens_clothing:          ["male_full_body"],
  womens_clothing:        ["female_full_body"],
  kids_clothing:          ["child_full_body"],
  // Footwear
  footwear:               ["male_full_body", "female_full_body", "child_full_body"],
  // Jewellery
  jewellery:              ["female_face_closeup", "male_face_closeup"],
  earrings:               ["female_face_closeup", "male_face_closeup"],
  // Bags
  bags:                   ["female_full_body", "male_full_body"],
  // Makeup
  makeup_lipstick:        ["female_face_closeup", "male_face_closeup"],
  makeup_foundation:      ["female_face_closeup", "male_face_closeup"],
  makeup_mascara:         ["female_face_closeup", "male_face_closeup"],
  // Furniture & decor — Phase 2, no user image category yet
  bedroom_furniture:      [] as unknown as UserImageCategory[],
  bathroom_furniture:     [] as unknown as UserImageCategory[],
  living_room_furniture:  [] as unknown as UserImageCategory[],
  kitchen_furniture:      [] as unknown as UserImageCategory[],
  home_decor:             [] as unknown as UserImageCategory[],
};

export function getRequiredCategories(productType: ProductType): UserImageCategory[] {
  return PRODUCT_TYPE_MAPPING[productType] ?? [];
}

/**
 * Returns the first available required category for a product type,
 * or null if the user has none of the required categories.
 */
export function resolveEligibleCategory(
  productType: ProductType,
  availableCategories: UserImageCategory[],
): UserImageCategory | null {
  const required = getRequiredCategories(productType);
  const available = new Set(availableCategories);
  return required.find((c) => available.has(c)) ?? null;
}

export function checkEligibility(
  productType: ProductType | undefined,
  summary: SelectionSummary | null,
): EligibilityResult {
  if (!productType) {
    return {
      eligible: false,
      reason: "PRODUCT_TYPE_NOT_FOUND",
      availableCategories: summary?.availableCategories ?? [],
    };
  }

  const available = summary?.availableCategories ?? [];
  const required = getRequiredCategories(productType);

  // Phase 2 product types have empty required categories in v1
  if (required.length === 0) {
    return {
      eligible: false,
      reason: "PRODUCT_TYPE_UNSUPPORTED",
      productType,
      availableCategories: available,
    };
  }

  const match = resolveEligibleCategory(productType, available);

  if (!match) {
    return {
      eligible: false,
      reason: "REQUIRED_USER_IMAGE_MISSING",
      productType,
      requiredCategory: required[0],
      availableCategories: available,
    };
  }

  return { eligible: true, productType, requiredCategory: match };
}
