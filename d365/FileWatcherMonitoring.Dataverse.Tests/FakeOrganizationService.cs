using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;

namespace FileWatcherMonitoring.Dataverse.Tests
{
    /// <summary>
    /// Minimal in-memory IOrganizationService — just the surface the Dataverse
    /// layer actually uses: Create, RetrieveMultiple (QueryExpression with Equal
    /// conditions + TopCount), and Execute(UpsertRequest) with alternate-key
    /// matching (emulating the fwm_filestate key on interfaceid + filepath).
    /// Everything else throws, so any new SDK call the code starts making fails
    /// a test loudly instead of passing silently.
    /// </summary>
    public class FakeOrganizationService : IOrganizationService
    {
        private readonly Dictionary<string, List<Entity>> _tables = new Dictionary<string, List<Entity>>();

        public IReadOnlyList<Entity> Rows(string logicalName) =>
            _tables.TryGetValue(logicalName, out var rows) ? rows : new List<Entity>();

        private List<Entity> Table(string logicalName)
        {
            if (!_tables.TryGetValue(logicalName, out var rows))
            {
                rows = new List<Entity>();
                _tables[logicalName] = rows;
            }
            return rows;
        }

        public Guid Create(Entity entity)
        {
            entity.Id = entity.Id == Guid.Empty ? Guid.NewGuid() : entity.Id;
            Table(entity.LogicalName).Add(entity);
            return entity.Id;
        }

        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            var qe = query as QueryExpression
                ?? throw new NotSupportedException("Fake supports QueryExpression only");
            IEnumerable<Entity> rows = Table(qe.EntityName);

            foreach (var condition in qe.Criteria?.Conditions ?? (IEnumerable<ConditionExpression>)Enumerable.Empty<ConditionExpression>())
            {
                if (condition.Operator != ConditionOperator.Equal)
                {
                    throw new NotSupportedException("Fake supports Equal conditions only");
                }
                var attribute = condition.AttributeName;
                var value = condition.Values[0];
                rows = rows.Where(r => Equals(r.GetAttributeValue<object>(attribute), value));
            }

            if (qe.TopCount.HasValue)
            {
                rows = rows.Take(qe.TopCount.Value);
            }
            var result = new EntityCollection();
            result.Entities.AddRange(rows);
            return result;
        }

        public OrganizationResponse Execute(OrganizationRequest request)
        {
            var upsert = request as UpsertRequest
                ?? throw new NotSupportedException("Fake supports UpsertRequest only");
            var target = upsert.Target;
            var rows = Table(target.LogicalName);

            var existing = rows.FirstOrDefault(r =>
                target.KeyAttributes.All(k => Equals(r.GetAttributeValue<object>(k.Key), k.Value)));

            if (existing != null)
            {
                foreach (var attribute in target.Attributes)
                {
                    existing[attribute.Key] = attribute.Value;
                }
            }
            else
            {
                Create(target);
            }
            return new UpsertResponse();
        }

        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotImplementedException();
        public void Update(Entity entity) => throw new NotImplementedException();
        public void Delete(string entityName, Guid id) => throw new NotImplementedException();
        public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotImplementedException();
        public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotImplementedException();
    }
}
