import type { ProductType, UserImageCategory, EligibilityResult, SelectionSummary, UserGender } from "./types.js";

/**
 * Maps each product type to the required user image categories (in priority order).
 * First match wins — if the user has any of the listed categories, they're eligible.
 */
export const PRODUCT_TYPE_MAPPING: Record<ProductType, UserImageCategory[]> = {
  // Eyewear
  sunglasses:             ["male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup"],
  eyeglasses:             ["male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup"],
  // Clothing
  mens_clothing:          ["male_full_body"],
  womens_clothing:        ["female_full_body"],
  kids_clothing:          ["kid_boy_full_body", "kid_girl_full_body"],
  // Footwear
  footwear:               ["male_full_body", "female_full_body", "kid_boy_full_body", "kid_girl_full_body"],
  // Jewellery
  jewellery:              ["female_face_closeup", "male_face_closeup"],
  earrings:               ["female_face_closeup", "male_face_closeup"],
  // Bags
  bags:                   ["female_full_body", "male_full_body"],
  // Makeup
  makeup_lipstick:        ["female_face_closeup", "male_face_closeup"],
  makeup_foundation:      ["female_face_closeup", "male_face_closeup"],
  makeup_mascara:         ["female_face_closeup", "male_face_closeup"],
  // Furniture & decor — requires a room photo of the matching space
  bedroom_furniture:      ["room_bedroom"],
  bathroom_furniture:     ["room_bathroom"],
  living_room_furniture:  ["room_living_room"],
  dining_room_furniture:  ["room_dining_room"],
  kitchen_furniture:      ["room_kitchen"],
  // home_decor accepts any room type — first available match wins
  home_decor:             ["room_bedroom", "room_living_room", "room_dining_room", "room_kitchen", "room_bathroom"],
};

// ─── Gender → Category resolution ────────────────────────────────────────────

type ProductNeed = "face" | "body" | "room";

const PRODUCT_NEEDS: Record<ProductType, ProductNeed> = {
  sunglasses:             "face",
  eyeglasses:             "face",
  mens_clothing:          "body",
  womens_clothing:        "body",
  kids_clothing:          "body",
  footwear:               "body",
  jewellery:              "face",
  earrings:               "face",
  bags:                   "body",
  makeup_lipstick:        "face",
  makeup_foundation:      "face",
  makeup_mascara:         "face",
  bedroom_furniture:      "room",
  bathroom_furniture:     "room",
  living_room_furniture:  "room",
  dining_room_furniture:  "room",
  kitchen_furniture:      "room",
  home_decor:             "room",
};

/**
 * Resolves the exact UserImageCategory to use for a person product + gender combo.
 * Returns null for furniture/room products (gender is irrelevant for those).
 */
export function resolveCategoryFromGender(
  productType: ProductType,
  gender: UserGender,
): UserImageCategory | null {
  const need = PRODUCT_NEEDS[productType];
  if (need === "room") return null;

  const isMale = gender === "male" || gender === "kid_boy";

  if (gender === "kid_boy")  return need === "face" ? "kid_boy_face_closeup"  : "kid_boy_full_body";
  if (gender === "kid_girl") return need === "face" ? "kid_girl_face_closeup" : "kid_girl_full_body";
  if (isMale)                return need === "face" ? "male_face_closeup"     : "male_full_body";
  return                            need === "face" ? "female_face_closeup"   : "female_full_body";
}

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
