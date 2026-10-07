/**
 * The seven spending categories, in the order they are shown everywhere.
 *
 * Lives here rather than in a component so the dashboard and the report join
 * the same ids to the same label, colour and icon — a category can never look
 * like two different things on two screens.
 */

import {
  UtensilsCrossed, CupSoda, Bike, Zap, Users, ShoppingBag, MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

import type { CategoryId } from "@/lib/types";

export type CategoryMeta = {
  id: CategoryId;
  label: string;
  Icon: LucideIcon;
  /** A literal hex, or a CSS var for the one category with no colour of its own. */
  color: string;
};

export const CATEGORIES: CategoryMeta[] = [
  { id: "food",    label: "Food",    Icon: UtensilsCrossed, color: "#fb923c" },
  // Lime sits in the widest gap left in the ramp above — far enough from Food's
  // orange and Social's emerald on either side that a chip or a ring segment is
  // never ambiguous at icon size.
  { id: "drink",   label: "Drink",   Icon: CupSoda,         color: "#a3e635" },
  { id: "transpo", label: "Transpo", Icon: Bike,            color: "#38bdf8" },
  { id: "bills",   label: "Bills",   Icon: Zap,             color: "#c084fc" },
  { id: "social",  label: "Social",  Icon: Users,           color: "#34d399" },
  { id: "shop",    label: "Shop",    Icon: ShoppingBag,     color: "#f472b6" },
  { id: "misc",    label: "Misc",    Icon: MoreHorizontal,  color: "var(--color-text-lo)" },
];

/**
 * The bucket for a category this build doesn't recognise — a row synced from a
 * newer client, or one hand-edited in the database.
 *
 * Exported so callers look it up by meaning rather than by position. The list
 * above is ordered for display and grows; an index into it is a bug waiting for
 * the next category to be added.
 */
export const MISC_CATEGORY: CategoryMeta = CATEGORIES.find((c) => c.id === "misc")!;
