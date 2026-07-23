/**
 * Catalog v2 API Routes
 * Clean, versioned API for catalog operations
 */
import { Request, Response, NextFunction } from 'express';
import { ICache } from '../cache/interface';
export interface CreateCatalogRouterOptions {
    cache: ICache;
    requireAdminApiKey: () => (req: Request, res: Response, next: NextFunction) => void;
}
export declare function createCatalogRouter(options: CreateCatalogRouterOptions): any;
//# sourceMappingURL=routes.d.ts.map