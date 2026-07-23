"use strict";
/**
 * Transform Shopify Admin API Product to Catalog v2 Domain Model
 * No truncation - preserves all data
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformAdminProduct = transformAdminProduct;
exports.transformAdminProducts = transformAdminProducts;
exports.transformAdminVariant = transformAdminVariant;
exports.transformAdminImage = transformAdminImage;
exports.transformAdminMedia = transformAdminMedia;
exports.transformAdminCollection = transformAdminCollection;
exports.transformAdminCollections = transformAdminCollections;
/**
 * Convert Shopify Admin API Money to Catalog Money
 */
function toMoney(shopifyMoney) {
    return {
        amount: shopifyMoney.amount,
        currencyCode: shopifyMoney.currencyCode,
    };
}
/**
 * Transform Shopify Admin Image to Catalog Image
 */
function transformImage(shopifyImage) {
    return {
        id: shopifyImage.id,
        url: shopifyImage.url,
        altText: shopifyImage.altText,
        width: shopifyImage.width,
        height: shopifyImage.height,
        src: shopifyImage.url, // Alias for compatibility
    };
}
/**
 * Transform Shopify Admin Media to Catalog Media
 */
function transformMedia(shopifyMedia) {
    const baseMedia = {
        id: shopifyMedia.id,
        mediaContentType: shopifyMedia.mediaContentType,
    };
    if (shopifyMedia.mediaContentType === 'IMAGE') {
        baseMedia.image = {
            id: shopifyMedia.image?.id,
            url: shopifyMedia.image?.url,
            altText: shopifyMedia.image?.altText,
            width: shopifyMedia.image?.width,
            height: shopifyMedia.image?.height,
            src: shopifyMedia.image?.url,
        };
    }
    else if (shopifyMedia.mediaContentType === 'VIDEO') {
        baseMedia.previewImage = shopifyMedia.preview?.image ? {
            id: shopifyMedia.preview.image.id,
            url: shopifyMedia.preview.image.url,
            altText: shopifyMedia.preview.image.altText,
            width: shopifyMedia.preview.image.width,
            height: shopifyMedia.preview.image.height,
            src: shopifyMedia.preview.image.url,
        } : undefined;
        baseMedia.sources = shopifyMedia.sources?.map((source) => ({
            url: source.url,
            mimeType: source.mimeType,
            format: source.format,
            height: source.height,
            width: source.width,
        })) || [];
    }
    else if (shopifyMedia.mediaContentType === 'EXTERNAL_VIDEO') {
        baseMedia.embedUrl = shopifyMedia.embedUrl;
        baseMedia.originUrl = shopifyMedia.originUrl;
        baseMedia.previewImage = shopifyMedia.preview?.image ? {
            id: shopifyMedia.preview.image.id,
            url: shopifyMedia.preview.image.url,
            altText: shopifyMedia.preview.image.altText,
            width: shopifyMedia.preview.image.width,
            height: shopifyMedia.preview.image.height,
            src: shopifyMedia.preview.image.url,
        } : undefined;
    }
    else if (shopifyMedia.mediaContentType === 'MODEL_3D') {
        baseMedia.previewImage = shopifyMedia.preview?.image ? {
            id: shopifyMedia.preview.image.id,
            url: shopifyMedia.preview.image.url,
            altText: shopifyMedia.preview.image.altText,
            width: shopifyMedia.preview.image.width,
            height: shopifyMedia.preview.image.height,
            src: shopifyMedia.preview.image.url,
        } : undefined;
        baseMedia.sources = shopifyMedia.sources?.map((source) => ({
            url: source.url,
            mimeType: source.mimeType,
            format: source.format,
            filesize: source.filesize,
        })) || [];
    }
    return baseMedia;
}
/**
 * Transform Shopify Admin Variant to Catalog Variant
 */
function transformVariant(shopifyVariant) {
    return {
        id: shopifyVariant.id,
        title: shopifyVariant.title,
        sku: shopifyVariant.sku,
        barcode: shopifyVariant.barcode,
        price: {
            amount: shopifyVariant.price?.amount || '0.00',
            currencyCode: shopifyVariant.price?.currencyCode || 'USD',
        },
        compareAtPrice: shopifyVariant.compareAtPrice ? {
            amount: shopifyVariant.compareAtPrice.amount,
            currencyCode: shopifyVariant.compareAtPrice.currencyCode,
        } : null,
        availableForSale: shopifyVariant.availableForSale ?? (shopifyVariant.quantityAvailable ?? shopifyVariant.inventoryQuantity ?? 0) > 0,
        quantityAvailable: shopifyVariant.quantityAvailable ?? shopifyVariant.inventoryQuantity ?? 0,
        currentlyNotInStock: shopifyVariant.currentlyNotInStock ?? false,
        selectedOptions: shopifyVariant.selectedOptions?.map((opt) => ({
            name: opt.name,
            value: opt.value,
        })) || [],
        inventoryQuantity: shopifyVariant.inventoryQuantity ?? 0,
        inventoryPolicy: shopifyVariant.inventoryPolicy ?? 'DENY',
        weight: shopifyVariant.weight ? {
            value: shopifyVariant.weight.value,
            unit: shopifyVariant.weight.unit,
        } : undefined,
        taxable: shopifyVariant.taxable ?? true,
        taxCode: shopifyVariant.taxCode,
        requiresShipping: shopifyVariant.requiresShipping ?? true,
        // Store selected options for image mapping
        _selectedOptions: shopifyVariant.selectedOptions,
    };
}
/**
 * Transform Shopify Admin Product Options
 */
function transformOptions(shopifyOptions) {
    return (shopifyOptions || []).map(opt => ({
        id: opt.id,
        name: opt.name,
        values: opt.values || [],
    }));
}
/**
 * Build variant image mapping via selectedOptions
 */
function buildVariantImageMap(adminProduct) {
    const variantImageMap = new Map();
    // Build a map of media by ID for quick lookup
    const mediaById = new Map();
    for (const mediaEdge of adminProduct.media?.edges || []) {
        const media = mediaEdge.node;
        mediaById.set(media.id, media);
    }
    // For each variant, find matching media based on selectedOptions
    for (const variantEdge of adminProduct.variants?.edges || []) {
        const variant = variantEdge.node;
        const variantId = variant.id;
        const variantImages = [];
        // First, check if variant has its own featured image
        if (variant.image) {
            variantImages.push(transformImage(variant.image));
        }
        // Match media by selectedOptions
        for (const mediaEdge of adminProduct.media?.edges || []) {
            const media = mediaEdge.node;
            // Check if media altText or other fields match variant options
            // Shopify links variant images via media's altText containing option values
            // or via explicit linking in the media object
            const matchesVariant = matchesVariantMedia(variant, media);
            if (matchesVariant) {
                if (media.mediaContentType === 'IMAGE' && media.image) {
                    variantImages.push(transformImage(media.image));
                }
                else if (media.previewImage) {
                    variantImages.push(transformImage(media.previewImage));
                }
            }
        }
        // Deduplicate by URL
        const uniqueImages = [];
        const seenUrls = new Set();
        for (const img of variantImages) {
            if (!seenUrls.has(img.url)) {
                seenUrls.add(img.url);
                uniqueImages.push(img);
            }
        }
        if (uniqueImages.length > 0) {
            variantImageMap.set(variantId, uniqueImages);
        }
    }
    return variantImageMap;
}
/**
 * Check if media matches a variant based on selectedOptions
 * This is a heuristic - Shopify doesn't have explicit variant-media linking in Admin API
 */
function matchesVariantMedia(variant, media) {
    // If media has selectedOptions that match variant
    if (media.selectedOptions) {
        return media.selectedOptions.every((opt) => variant.selectedOptions?.some((vOpt) => vOpt.name === opt.name && vOpt.value === opt.value));
    }
    // Heuristic: Check if media altText contains variant option values
    if (media.altText && variant.selectedOptions) {
        return variant.selectedOptions.some((opt) => media.altText.toLowerCase().includes(opt.value.toLowerCase()));
    }
    // If media is directly linked to variant (Shopify sometimes includes this)
    if (media.variantIds?.includes(variant.id)) {
        return true;
    }
    return false;
}
/**
 * Transform Shopify Admin Product to Catalog Product
 * NO TRUNCATION - preserves all data
 */
function transformAdminProduct(adminProduct) {
    if (!adminProduct) {
        throw new Error('Admin product is null or undefined');
    }
    // Build variant image map BEFORE transforming variants
    const variantImageMap = buildVariantImageMap(adminProduct);
    // Transform images
    const imageEdges = (adminProduct.images?.edges || []).map((edge) => ({
        node: transformImage(edge.node),
        cursor: edge.cursor,
    }));
    const images = {
        edges: imageEdges,
        pageInfo: adminProduct.images?.pageInfo || {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null
        },
    };
    // Transform media
    const mediaEdges = (adminProduct.media?.edges || []).map((edge) => ({
        node: transformMedia(edge.node),
        cursor: edge.cursor,
    }));
    const media = {
        edges: mediaEdges,
        pageInfo: adminProduct.media?.pageInfo || {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null
        },
    };
    // Transform variants with their images
    const variantEdges = (adminProduct.variants?.edges || []).map((edge) => {
        const variant = transformVariant(edge.node);
        const variantId = edge.node.id;
        // Attach variant-specific images
        const variantImages = variantImageMap.get(variantId) || [];
        if (variantImages.length > 0) {
            variant._images = variantImages; // Attach for downstream use
        }
        return {
            node: variant,
            cursor: edge.cursor,
        };
    });
    // Transform options
    const options = transformOptions(adminProduct.options);
    // Build price range
    const priceRange = adminProduct.priceRange ? {
        minVariantPrice: toMoney(adminProduct.priceRange.minVariantPrice),
        maxVariantPrice: toMoney(adminProduct.priceRange.maxVariantPrice),
    } : {
        minVariantPrice: { amount: '0', currencyCode: 'USD' },
        maxVariantPrice: { amount: '0', currencyCode: 'USD' },
    };
    // Build compare at price range
    const compareAtPriceRange = adminProduct.compareAtPriceRange ? {
        minVariantPrice: toMoney(adminProduct.compareAtPriceRange.minVariantPrice),
        maxVariantPrice: toMoney(adminProduct.compareAtPriceRange.maxVariantPrice),
    } : null;
    // Featured image
    const featuredImage = adminProduct.featuredImage
        ? transformImage(adminProduct.featuredImage)
        : null;
    // Collections
    const collectionEdges = (adminProduct.collections?.edges || []).map((edge) => ({
        node: {
            id: edge.node.id,
            handle: edge.node.handle,
            title: edge.node.title,
        },
        cursor: edge.cursor,
    }));
    // SEO
    const seo = {
        title: adminProduct.seo?.title || null,
        description: adminProduct.seo?.description || null,
    };
    // Calculate available for sale from variants
    const variantList = (adminProduct.variants?.edges || []).map((e) => e.node);
    const availableForSale = variantList.some((v) => v.availableForSale ?? (v.quantityAvailable ?? v.inventoryQuantity ?? 0) > 0);
    // Total inventory
    const totalInventory = variantList.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
    // Build description (plain text fallback)
    const description = adminProduct.descriptionHtml
        ? adminProduct.descriptionHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    return {
        id: adminProduct.id,
        title: adminProduct.title,
        handle: adminProduct.handle,
        descriptionHtml: adminProduct.descriptionHtml || '',
        description,
        vendor: adminProduct.vendor || '',
        productType: adminProduct.productType || '',
        tags: adminProduct.tags || [],
        status: adminProduct.status || 'ACTIVE',
        availableForSale,
        featuredImage,
        images,
        media,
        priceRange,
        compareAtPriceRange,
        variants: { edges: variantEdges.map(e => ({ node: e.node })) },
        collections: { edges: collectionEdges },
        options: options.map(opt => ({ id: opt.id, name: opt.name, values: opt.values })),
        seo: {
            title: seo.title,
            description: seo.description,
        },
        totalInventory,
        createdAt: adminProduct.createdAt,
        updatedAt: adminProduct.updatedAt,
        publishedAt: adminProduct.publishedAt,
        _syncedAt: new Date().toISOString(),
        _version: '1',
    };
}
/**
 * Transform Shopify Admin Money to Catalog Money
 */
function toMoney(shopifyMoney) {
    return {
        amount: shopifyMoney.amount,
        currencyCode: shopifyMoney.currencyCode,
    };
}
/**
 * Transform multiple admin products
 */
function transformAdminProducts(adminProducts) {
    return adminProducts.map(transformAdminProduct).filter(Boolean);
}
/**
 * Transform single admin variant
 */
function transformAdminVariant(adminVariant) {
    return transformVariant(adminVariant);
}
/**
 * Transform admin image
 */
function transformAdminImage(adminImage) {
    return transformImage(adminImage);
}
/**
 * Transform admin media
 */
function transformAdminMedia(adminMedia) {
    return transformMedia(adminMedia);
}
/**
 * Transform admin collection
 */
function transformAdminCollection(adminCollection) {
    if (!adminCollection)
        return null;
    const image = adminCollection.image
        ? {
            id: adminCollection.image.id,
            url: adminCollection.image.url,
            altText: adminCollection.image.altText,
            width: adminCollection.image.width,
            height: adminCollection.image.height,
            src: adminCollection.image.url,
        }
        : null;
    const productHandles = (adminCollection.products?.edges || [])
        .map((edge) => edge.node?.handle)
        .filter(Boolean);
    const seo = {
        title: adminCollection.seo?.title || null,
        description: adminCollection.seo?.description || null,
    };
    return {
        id: adminCollection.id,
        title: adminCollection.title,
        handle: adminCollection.handle,
        descriptionHtml: adminCollection.descriptionHtml || '',
        description: adminCollection.descriptionHtml
            ? adminCollection.descriptionHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
            : '',
        image,
        products: { edges: [] }, // Will be populated when needed
        updatedAt: adminCollection.updatedAt,
        seo,
        sortOrder: adminCollection.sortOrder || 'MANUAL',
        rules: adminCollection.ruleSet?.rules?.map((rule) => ({
            column: rule.column,
            relation: rule.relation,
            condition: rule.condition,
        })) || [],
        productHandles,
    };
}
function transformAdminCollections(adminCollections) {
    return adminCollections.map(transformAdminCollection).filter(Boolean);
}
//# sourceMappingURL=product.js.map