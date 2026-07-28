/**
 * The six spending categories, in the order they are shown everywhere.
 *
 * Lives here rather than in a component so the dashboard and the report join
 * the same ids to the same label, colour and icon — a category can never look
 * like two different things on two screens.
 */

import {
  UtensilsCrossed, Bike, Zap, Users, ShoppingBag, MoreHorizontal,
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
  { id: "transpo", label: "Transpo", Icon: Bike,            color: "#38bdf8" },
  { id: "bills",   label: "Bills",   Icon: Zap,             color: "#c084fc" },
  { id: "social",  label: "Social",  Icon: Users,           color: "#34d399" },
  { id: "shop",    label: "Shop",    Icon: ShoppingBag,     color: "#f472b6" },
  { id: "misc",    label: "Misc",    Icon: MoreHorizontal,  color: "var(--color-text-lo)" },
];
