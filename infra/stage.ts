export const domain = (() => {
  if ($app.stage === "production") return "serac.build"
  if ($app.stage === "dev") return "dev.serac.build"
  return `${$app.stage}.dev.serac.build`
})()

export const zoneID = "430ba34c138cfb5360826c4909f99be8"

new cloudflare.RegionalHostname("RegionalHostname", {
  hostname: domain,
  regionKey: "us",
  zoneId: zoneID,
})

export const shortDomain = (() => {
  if ($app.stage === "production") return "snfl.dev"
  if ($app.stage === "dev") return "dev.snfl.dev"
  return `${$app.stage}.dev.snfl.dev`
})()
