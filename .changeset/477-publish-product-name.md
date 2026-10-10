---
"@jevitate/cli": patch
---

`publish journeeze` / MCP `publish_to_journeeze` now send the connected Journeeze product's real name as the bundle's `product.name` instead of the project's `package.json` name, and gain `--product-name` / `productName` to override it (must match `whoami`). A `--dry-run` verifies the key with `whoami` and refuses a mismatch with `E_JOURNEEZE_PRODUCT_MISMATCH` (#477).
