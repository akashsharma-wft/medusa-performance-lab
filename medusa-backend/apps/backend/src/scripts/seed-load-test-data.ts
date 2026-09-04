import { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows";

// Extends the default demo seed with:
//  - a larger, realistic product catalog for k6 to browse/checkout against
//  - one deliberately low-stock variant, used by k6/oversell.js to verify
//    Medusa's inventory reservation actually prevents overselling under
//    concurrent load (not just in docs).
//
// Run with: npx medusa exec ./src/scripts/seed-load-test-data.ts

const PRODUCT_COUNT = 200;
const LOW_STOCK_QTY = 5;

export default async function seedLoadTestData({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: salesChannels } = await query.graph({
    entity: "sales_channel",
    fields: ["id"],
  });
  const salesChannelId = salesChannels[0].id;

  const { data: stockLocations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const stockLocationId = stockLocations[0].id;

  const { data: shippingProfiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  });
  const shippingProfileId = shippingProfiles[0].id;

  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name"],
  });

  logger.info(`Seeding ${PRODUCT_COUNT} load-test products...`);

  const batchSize = 20;
  for (let batchStart = 0; batchStart < PRODUCT_COUNT; batchStart += batchSize) {
    const batch: any[] = [];
    const end = Math.min(batchStart + batchSize, PRODUCT_COUNT);
    for (let i = batchStart; i < end; i++) {
      const category = categories[i % categories.length];
      batch.push({
        title: `Load Test Product ${i + 1}`,
        category_ids: [category.id],
        description: `Synthetic catalog item #${i + 1} generated for checkout load testing.`,
        handle: `load-test-product-${i + 1}`,
        weight: 300,
        status: ProductStatus.PUBLISHED,
        shipping_profile_id: shippingProfileId,
        options: [{ title: "Variant", values: ["Default"] }],
        variants: [
          {
            title: "Default",
            sku: `LOADTEST-${i + 1}`,
            options: { Variant: "Default" },
            prices: [
              { amount: 20, currency_code: "eur" },
              { amount: 25, currency_code: "usd" },
            ],
          },
        ],
        sales_channels: [{ id: salesChannelId }],
      });
    }
    await createProductsWorkflow(container).run({ input: { products: batch as any } });
    logger.info(`  ...seeded products ${batchStart + 1}-${end}`);
  }

  logger.info("Seeding the deliberately low-stock oversell-test product...");
  const { result: oversellProducts } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Oversell Test Item (Limited Drop)",
          description: "Deliberately low-stock product used to verify inventory reservation under concurrent checkout load.",
          handle: "oversell-test-item",
          weight: 300,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfileId,
          options: [{ title: "Variant", values: ["Default"] }],
          variants: [
            {
              title: "Default",
              sku: "OVERSELL-TEST-1",
              options: { Variant: "Default" },
              prices: [
                { amount: 20, currency_code: "eur" },
                { amount: 25, currency_code: "usd" },
              ],
            },
          ],
          sales_channels: [{ id: salesChannelId }],
        },
      ] as any,
    },
  });

  const oversellVariantId = oversellProducts[0].variants![0].id;
  const oversellSku = "OVERSELL-TEST-1";

  // Scoped to SKUs this script just created (LOADTEST-* and the oversell
  // item) rather than every inventory_item in the database.
  // createInventoryLevelsWorkflow throws "already exists" for any item that
  // already has a level at this location -- it does NOT skip duplicates --
  // and an unfiltered query also picks up whatever the base project seed
  // (initial-data-seed.ts, run by `medusa db:migrate`) already created
  // levels for, which collides on every fresh database.
  const { data: newInventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
  });

  const levelsToCreate = newInventoryItems
    .filter((item) => item.sku && (item.sku.startsWith("LOADTEST-") || item.sku === oversellSku))
    .map((item) => ({
      location_id: stockLocationId,
      inventory_item_id: item.id,
      stocked_quantity: item.sku === oversellSku ? LOW_STOCK_QTY : 1000000,
    }));

  await createInventoryLevelsWorkflow(container).run({
    input: { inventory_levels: levelsToCreate },
  });

  logger.info(`Done. Low-stock variant id for k6: ${oversellVariantId} (qty ${LOW_STOCK_QTY})`);
  logger.info(`LOW_STOCK_VARIANT_ID=${oversellVariantId}`);
}
