// Fills DATA_DIR/nutrition.db with synthetic history for looking at the
// dashboard (screenshots, manual testing). Invented foods only.
//
//   DATA_DIR=$(mktemp -d) bun scripts/seed-demo.ts
//   DATA_DIR=... DASHBOARD_PASSWORD='a-long-test-password' bun src/index.ts
import { OWNER_ID, closeDb, insertMeal } from "../src/db/repo.js";
import { seedDemoData } from "../src/dashboard/demo-data.js";
import { todayInTz } from "../src/tz.js";

if (!process.env.DATA_DIR) {
    console.error("Set DATA_DIR to a scratch directory first.");
    process.exit(2);
}
await seedDemoData(45, "UTC");
// A name that is long and unbroken, and one that tries to be markup: the pages
// must wrap the first and show the second as text.
await insertMeal(OWNER_ID, {
    description:
        "Extraordinarily-long-unbroken-meal-name-with-many-hyphens-to-test-wrapping-on-narrow-screens-0123456789",
    meal_type: "snack",
    calories: 120,
    protein_g: 3,
    carbs_g: 20,
    fat_g: 3,
    logged_at: `${todayInTz("UTC")}T08:45:00Z`,
});
await insertMeal(OWNER_ID, {
    description: `<b>bold</b> <script>alert("x")</script>`,
    meal_type: "snack",
    calories: 90,
    protein_g: 1,
    carbs_g: 10,
    fat_g: 1,
    logged_at: `${todayInTz("UTC")}T09:10:00Z`,
});
closeDb();
console.log(`seeded ${process.env.DATA_DIR}`);
