import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { createInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";

// Follow-up to seed-load-test-data.ts: creates inventory levels ONLY for
// items that don't have one yet (the workflow errors on duplicates rather
// than skipping them, which failed the original combined run).
//
// Run with: npx medusa exec ./src/scripts/fix-inventory-levels.ts

const LOW_STOCK_QTY = 5;
const OVERSELL_SKU = "OVERSELL-TEST-1";

export default async function fixInventoryLevels({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const stockLocationId = stockLocations[0].id;

  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "location_levels.id"],
  });

  const missing = items.filter(
    (item) => !item.location_levels || item.location_levels.length === 0
  );

  logger.info(`Creating inventory levels for ${missing.length} items missing one...`);

  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: missing.map((item) => ({
        location_id: stockLocationId,
        inventory_item_id: item.id,
        stocked_quantity: item.sku === OVERSELL_SKU ? LOW_STOCK_QTY : 1000000,
      })),
    },
  });

  const oversell = items.find((i) => i.sku === OVERSELL_SKU);
  logger.info(`Done. Oversell item ${oversell?.id} stocked at ${LOW_STOCK_QTY}.`);

  // k6 needs the VARIANT id, not the inventory item id:
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku: OVERSELL_SKU },
  });
  logger.info(`LOW_STOCK_VARIANT_ID=${variants[0]?.id}`);
}
