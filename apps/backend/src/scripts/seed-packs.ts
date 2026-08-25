// Seed the 77 real mumchimp packs from api.mumchimp.com/catalog into Medusa 2.
// Run: npx medusa exec ./src/scripts/seed-packs.ts   (CATALOG_JSON=path overrides the source)
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow, createProductsWorkflow, createRegionsWorkflow,
  createSalesChannelsWorkflow, createShippingProfilesWorkflow, createStockLocationsWorkflow,
  linkSalesChannelsToStockLocationWorkflow, updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"
import { readFileSync } from "node:fs"

type Pack = Record<string, any> & { id: string; title: string; pricePence: number; sector?: string }

export default async function seedPacks({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const src = process.env.CATALOG_JSON
  let raw: any
  if (src) raw = JSON.parse(readFileSync(src, "utf8"))
  else raw = await (await fetch("https://api.mumchimp.com/catalog")).json()
  const packs: Pack[] = Array.isArray(raw) ? raw : raw.packs ?? raw.items
  logger.info(`catalog: ${packs.length} packs`)

  // store: GBP default currency and one sales channel
  const storeModule = container.resolve(Modules.STORE)
  const [store] = await storeModule.listStores()
  let { data: channels } = await query.graph({ entity: "sales_channel", fields: ["id"], filters: { name: "Mumchimp Web" } })
  if (!channels.length) {
    const { result } = await createSalesChannelsWorkflow(container).run({ input: { salesChannelsData: [{ name: "Mumchimp Web" }] } })
    channels = result
  }
  await updateStoresWorkflow(container).run({ input: { selector: { id: store.id }, update: {
    supported_currencies: [{ currency_code: "gbp", is_default: true }], default_sales_channel_id: channels[0].id } } })

  const { data: regions } = await query.graph({ entity: "region", fields: ["id"], filters: { name: "United Kingdom" } })
  if (!regions.length) {
    await createRegionsWorkflow(container).run({ input: { regions: [{ name: "United Kingdom", currency_code: "gbp", countries: ["gb"], payment_providers: ["pp_system_default"] }] } })
  }
  const { data: locs } = await query.graph({ entity: "stock_location", fields: ["id"], filters: { name: "Digital" } })
  let locId = locs[0]?.id
  if (!locId) {
    const { result } = await createStockLocationsWorkflow(container).run({ input: { locations: [{ name: "Digital", address: { city: "London", country_code: "GB", address_1: "" } }] } })
    locId = result[0].id
    await linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: locId, add: [channels[0].id] } })
  }
  const { data: profiles } = await query.graph({ entity: "shipping_profile", fields: ["id"], filters: { type: "digital" } })
  let profileId = profiles[0]?.id
  if (!profileId) {
    const { result } = await createShippingProfilesWorkflow(container).run({ input: { data: [{ name: "Digital delivery", type: "digital" }] } })
    profileId = result[0].id
  }

  // categories from sector
  const sectors = [...new Set(packs.map(p => p.sector).filter(Boolean))] as string[]
  const { data: existingCats } = await query.graph({ entity: "product_category", fields: ["id", "name"] })
  const catByName = new Map(existingCats.map((c: any) => [c.name, c.id]))
  const missing = sectors.filter(s => !catByName.has(s))
  if (missing.length) {
    const { result } = await createProductCategoriesWorkflow(container).run({ input: { product_categories: missing.map(name => ({ name, is_active: true })) } })
    result.forEach((c: any) => catByName.set(c.name, c.id))
  }

  const { data: existing } = await query.graph({ entity: "product", fields: ["handle"] })
  const have = new Set(existing.map((p: any) => p.handle))
  const products = packs.filter(p => !have.has(p.id)).map(p => ({
    title: p.title, handle: p.id, status: ProductStatus.PUBLISHED,
    subtitle: p.cardLine, description: [p.headline, "", p.oneLine, "", p.whoPays ? `Who pays: ${p.whoPays}` : "", p.proofPoint ? `Proof: ${p.proofPoint}` : ""].join("\n"),
    category_ids: p.sector && catByName.get(p.sector) ? [catByName.get(p.sector)] : [],
    shipping_profile_id: profileId, sales_channels: [{ id: channels[0].id }],
    metadata: Object.fromEntries(Object.entries(p).filter(([k]) => !["title", "id"].includes(k))),
    options: [{ title: "Format", values: ["PDF"] }],
    variants: [{ title: "PDF", sku: `pack-${p.id}`, manage_inventory: false, options: { Format: "PDF" },
      prices: [{ amount: p.pricePence / 100, currency_code: "gbp" }] }],
  }))
  if (products.length) await createProductsWorkflow(container).run({ input: { products } })
  logger.info(`seeded ${products.length} new packs, ${have.size} already present, ${sectors.length} categories`)
}
