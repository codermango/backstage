/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Logger } from 'winston';
import { ConflictError, NotFoundError } from '@backstage/errors';
import { CatalogApi } from '@backstage/catalog-client';
import {
  EntityName,
  parseEntityRef,
  RELATION_MEMBER_OF,
  stringifyEntityRef,
  UserEntity,
} from '@backstage/catalog-model';
import { TokenManager } from '@backstage/backend-common';

type UserQuery = {
  annotations: Record<string, string>;
};

type MemberClaimQuery = {
  entityRefs: string[];
  logger?: Logger;
};

/**
 * A catalog client tailored for reading out identity data from the catalog.
 */
export class CatalogIdentityClient {
  private readonly catalogApi: CatalogApi;
  private readonly tokenManager: TokenManager;

  constructor(options: { catalogApi: CatalogApi; tokenManager: TokenManager }) {
    this.catalogApi = options.catalogApi;
    this.tokenManager = options.tokenManager;
  }

  /**
   * Looks up a single user using a query.
   *
   * Throws a NotFoundError or ConflictError if 0 or multiple users are found.
   */
  async findUser(query: UserQuery): Promise<UserEntity> {
    const filter: Record<string, string> = {
      kind: 'user',
    };
    for (const [key, value] of Object.entries(query.annotations)) {
      filter[`metadata.annotations.${key}`] = value;
    }

    // TODO(Rugvip): cache the token
    const { token } = await this.tokenManager.getToken();
    const { items } = await this.catalogApi.getEntities({ filter }, { token });

    if (items.length !== 1) {
      if (items.length > 1) {
        throw new ConflictError('User lookup resulted in multiple matches');
      } else {
        throw new NotFoundError('User not found');
      }
    }

    return items[0] as UserEntity;
  }

  /**
   * Resolve additional entity claims from the catalog, using the passed-in entity names. Designed
   * to be used within a `signInResolver` where additional entity claims might be provided, but
   * group membership and transient group membership lean on imported catalog relations.
   *
   * Returns a superset of the entity names that can be passed directly to `issueToken` as `ent`.
   */
  async resolveCatalogMembership(query: MemberClaimQuery): Promise<string[]> {
    const { entityRefs, logger } = query;
    const resolvedEntityRefs = entityRefs
      .map((ref: string) => {
        try {
          const parsedRef = parseEntityRef(ref.toLocaleLowerCase('en-US'), {
            defaultKind: 'user',
            defaultNamespace: 'default',
          });
          return parsedRef;
        } catch {
          logger?.warn(`Failed to parse entityRef from ${ref}, ignoring`);
          return null;
        }
      })
      .filter((ref): ref is EntityName => ref !== null);

    const filter = resolvedEntityRefs.map(ref => ({
      kind: ref.kind,
      'metadata.namespace': ref.namespace,
      'metadata.name': ref.name,
    }));
    const { token } = await this.tokenManager.getToken();
    const entities = await this.catalogApi
      .getEntities({ filter }, { token })
      .then(r => r.items);

    if (entityRefs.length !== entities.length) {
      const foundEntityNames = entities.map(stringifyEntityRef);
      const missingEntityNames = resolvedEntityRefs
        .map(stringifyEntityRef)
        .filter(s => !foundEntityNames.includes(s));
      logger?.debug(`Entities not found for refs ${missingEntityNames.join()}`);
    }

    const memberOf = entities.flatMap(
      e =>
        e!.relations
          ?.filter(r => r.type === RELATION_MEMBER_OF)
          .map(r => r.target) ?? [],
    );

    const newEntityRefs = [
      ...new Set(resolvedEntityRefs.concat(memberOf).map(stringifyEntityRef)),
    ];

    logger?.debug(`Found catalog membership: ${newEntityRefs.join()}`);
    return newEntityRefs;
  }
}
