import { MedusaContainer } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Resets the low-stock SKU to exactly 5 available units, THROUGH Medusa's own
// module services rather than raw SQL.
//
// Editing inventory_level directly leaves Medusa reporting
// "insufficient_inventory" even when the table says stocked=5, reserved=0 --
// availability is derived through the inventory module, not read straight off
// that column. Anything the lab changes behind Medusa's back is a lie the app
// will not believe.
//
//   npx medusa exec ./src/scripts/reset-oversell.ts

const OVERSELL_SKU = "OVERSELL-TEST-1"
const TARGET_QTY = 5

export default async function resetOversell({
  container,
}: {
  container: MedusaContainer
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const inventory: any = container.resolve(Modules.INVENTORY)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "location_levels.id", "location_levels.location_id",
             "location_levels.stocked_quantity", "location_levels.reserved_quantity"],
    filters: { sku: OVERSELL_SKU },
  })

  if (!items.length) {
    logger.error(`no inventory item with sku ${OVERSELL_SKU}`)
    return
  }

  const item = items[0]
  logger.info(`before: ${JSON.stringify(item.location_levels)}`)

  // Release every reservation still attached to this item.
  const reservations = await inventory.listReservationItems({
    inventory_item_id: item.id,
  })
  if (reservations.length) {
    await inventory.deleteReservationItems(reservations.map((r: any) => r.id))
    logger.info(`released ${reservations.length} reservation(s)`)
  }

  for (const level of item.location_levels ?? []) {
    if (!level?.location_id) {
      continue
    }
    await inventory.updateInventoryLevels([
      {
        inventory_item_id: item.id,
        location_id: level.location_id,
        stocked_quantity: TARGET_QTY,
      },
    ])
  }

  const { data: after } = await query.graph({
    entity: "inventory_item",
    fields: ["sku", "location_levels.stocked_quantity",
             "location_levels.reserved_quantity", "location_levels.available_quantity"],
    filters: { sku: OVERSELL_SKU },
  })
  logger.info(`after: ${JSON.stringify(after[0].location_levels)}`)
}
