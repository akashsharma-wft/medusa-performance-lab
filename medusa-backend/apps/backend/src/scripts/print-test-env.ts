import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { linkSalesChannelsToApiKeyWorkflow } from "@medusajs/medusa/core-flows"

// Prints the four values k6 needs, read straight from THIS install.
//
// A fresh `seed-load-test-data.ts` run creates its own region, sales channel,
// publishable key and low-stock variant — none of which match the IDs in any
// other environment's k6/.env.k6. Copy this script's output into your own
// k6/.env.k6 rather than reusing anyone else's file.
//
//   npx medusa exec ./src/scripts/print-test-env.ts

const OVERSELL_SKU = "OVERSELL-TEST-1"

export default async function printTestEnv({
  container,
}: {
  container: MedusaContainer
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: regions } = await query.graph({ entity: "region", fields: ["id"] })
  const { data: channels } = await query.graph({ entity: "sales_channel", fields: ["id"] })
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id"],
    filters: { sku: OVERSELL_SKU },
  })

  const apiKeyModule = container.resolve(Modules.API_KEY)
  const [existing] = await apiKeyModule.listApiKeys({ type: "publishable" })
  let publishableKey = existing?.token

  if (!publishableKey) {
    const created = await apiKeyModule.createApiKeys({
      title: "k6 load test",
      type: "publishable",
      created_by: "print-test-env",
    })
    publishableKey = created.token
    if (channels[0]) {
      await linkSalesChannelsToApiKeyWorkflow(container).run({
        input: { id: created.id, add: [channels[0].id] },
      })
    }
  }

  if (!regions[0] || !channels[0] || !variants[0]) {
    logger.warn(
      "Missing region, sales channel, or the low-stock variant — run seed-load-test-data.ts first."
    )
    return
  }

  logger.info("Paste this into k6/.env.k6:")
  logger.info("----------------------------------------")
  logger.info(`MEDUSA_URL=http://localhost:9000`)
  logger.info(`MEDUSA_PUBLISHABLE_KEY=${publishableKey}`)
  logger.info(`MEDUSA_REGION_ID=${regions[0].id}`)
  logger.info(`MEDUSA_SALES_CHANNEL_ID=${channels[0].id}`)
  logger.info(`LOW_STOCK_VARIANT_ID=${variants[0].id}`)
  logger.info(`LOW_STOCK_QTY=5`)
  logger.info("----------------------------------------")
}
