use crate::{
    audit::{self, Snapshot},
    auth::Auth,
    db::Database,
    error::{Error, Result},
    query::{Mutation, Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

const USER_COLUMNS: &str =
    "id,email,display_name,status,revision,created_at,updated_at,last_login_at";
const ROLE_COLUMNS: &str = "r.id,r.display_name,r.system_role,r.revision,r.created_at,r.updated_at,(SELECT coalesce(json_group_array(permission_key),'[]') FROM (SELECT permission_key FROM role_permissions WHERE role_id=r.id AND revoked_at IS NULL ORDER BY permission_key)) AS permissions_json";

pub async fn users(db: &Database, actor: Actor, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        security::require(tx, &actor, "users.view", None)?;
        let mut statement = tx.prepare(&format!(
            "SELECT {USER_COLUMNS} FROM users WHERE (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2"
        ))?;
        let data = statement
            .query_map(params![paging.cursor, (paging.limit + 1) as i64], row_json)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        paging.page(data)
    })
    .await
}

pub async fn user(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move |tx| {
        security::require(tx, &actor, "users.view", None)?;
        Ok(tx.query_row(
            &format!("SELECT {USER_COLUMNS} FROM users WHERE id=?1"),
            [id],
            row_json,
        )?)
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewUser {
    email: String,
    display_name: String,
    password: String,
}

pub async fn create_user(auth: &Auth, actor: Actor, input: NewUser) -> Result<Mutation> {
    let email = validation::email(&input.email)?;
    let name = validation::text(&input.display_name, 100, true, false)?;
    let check = actor.clone();
    auth.db
        .read(move |tx| security::require(tx, &check, "users.manage", None))
        .await?;
    let hash = auth.hash(input.password).await?;
    auth.db.write(move |tx| {
        security::require(tx,&actor,"users.manage",None)?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'active',?5,?5)",params![id,email,name,hash,now])?;
        let mut after=Snapshot::revision(1);after.status=Some("active".into());
        audit::mutation(tx,&actor,"user",&id,None,"created",(None, after))?;
        Ok(Mutation{id,revision:1})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserProfile {
    email: String,
    display_name: String,
    expected_revision: i64,
}

pub async fn update_user(
    db: &Database,
    actor: Actor,
    id: String,
    input: UserProfile,
) -> Result<Mutation> {
    let email = validation::email(&input.email)?;
    let name = validation::text(&input.display_name, 100, true, false)?;
    db.write(move |tx| {
        security::require(tx, &actor, "users.manage", None)?;
        let (previous, status): (i64, String) = tx.query_row(
            "SELECT revision,status FROM users WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let revision = next_revision(previous, input.expected_revision)?;
        tx.execute(
            "UPDATE users SET email=?1,display_name=?2,revision=?3,updated_at=?4 WHERE id=?5",
            params![email, name, revision, validation::now(), id],
        )?;
        audit::mutation(
            tx,
            &actor,
            "user",
            &id,
            None,
            "updated",
            (
                Some(user_snapshot(previous, &status)),
                user_snapshot(revision, &status),
            ),
        )?;
        Ok(Mutation { id, revision })
    })
    .await
}

pub async fn disable_user(
    db: &Database,
    actor: Actor,
    id: String,
    input: crate::clients::ConfirmRevision,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        security::require(tx, &actor, "users.manage", None)?;
        if actor.user_id == id {
            return Err(Error::Conflict("self_disable"));
        }
        let (previous, status): (i64, String) = tx.query_row(
            "SELECT revision,status FROM users WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if status != "active" {
            return Err(Error::Conflict("conflict"));
        }
        let had_admin = has_administrator(tx)?;
        let revision = next_revision(previous, input.expected_revision)?;
        let now = validation::now();
        tx.execute(
            "UPDATE users SET status='disabled',revision=?1,updated_at=?2 WHERE id=?3",
            params![revision, now, id],
        )?;
        tx.execute(
            "UPDATE sessions SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL",
            params![now, id],
        )?;
        if had_admin {
            security::preserve_administrator(tx)?;
        }
        audit::mutation(
            tx,
            &actor,
            "user",
            &id,
            None,
            "disabled",
            (
                Some(user_snapshot(previous, &status)),
                user_snapshot(revision, "disabled"),
            ),
        )?;
        Ok(Mutation { id, revision })
    })
    .await
}

pub async fn roles(db: &Database, actor: Actor, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        security::require(tx,&actor,"roles.view",None)?;
        let mut statement=tx.prepare(&format!("SELECT {ROLE_COLUMNS} FROM roles r WHERE (?1 IS NULL OR r.id>?1) ORDER BY r.id LIMIT ?2"))?;
        let data=statement.query_map(params![paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn role(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move |tx| {
        security::require(tx, &actor, "roles.view", None)?;
        Ok(tx.query_row(
            &format!("SELECT {ROLE_COLUMNS} FROM roles r WHERE r.id=?1"),
            [id],
            row_json,
        )?)
    })
    .await
}

pub async fn catalog(db: &Database, actor: Actor) -> Result<Value> {
    db.read(move |tx| {
        security::require(tx,&actor,"roles.view",None)?;
        let mut statement=tx.prepare("SELECT permission_key AS permission,scope_kind AS scope,description FROM permissions ORDER BY permission_key")?;
        Ok(Value::Array(statement.query_map([],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewRole {
    display_name: String,
    permissions: Vec<String>,
}

pub async fn create_role(db: &Database, actor: Actor, input: NewRole) -> Result<Mutation> {
    let name = validation::text(&input.display_name, 100, true, false)?;
    let permissions = permission_set(input.permissions)?;
    db.write(move |tx| {
        security::require(tx,&actor,"roles.manage",None)?;
        for permission in &permissions {control(tx,&actor,permission,None)?;}
        let id=validation::new_id();let now=validation::now();let key=format!("custom_{}",&id.replace('-',"")[..24]);
        tx.execute("INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",params![id,key,name,now])?;
        for permission in &permissions {add_permission(tx,&id,permission,&now)?;}
        audit::mutation(tx,&actor,"role",&id,None,"created",(None, Snapshot::revision(1)))?;
        Ok(Mutation{id,revision:1})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplacePermissions {
    permissions: Vec<String>,
    expected_revision: i64,
    confirm: bool,
}

pub async fn replace_permissions(
    db: &Database,
    actor: Actor,
    id: String,
    input: ReplacePermissions,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    let permissions = permission_set(input.permissions)?;
    db.write(move |tx| {
        security::require(tx,&actor,"roles.manage",None)?;
        let (previous,builtin):(i64,bool)=tx.query_row("SELECT revision,system_role FROM roles WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if builtin {return Err(Error::Conflict("system_role"));}
        let revision=next_revision(previous,input.expected_revision)?;
        let current=role_permissions(tx,&id,None)?;
        for permission in current.iter().chain(permissions.iter()) {control(tx,&actor,permission,None)?;}
        let had_admin=has_administrator(tx)?;let now=validation::now();
        for permission in permissions.difference(&current) {add_permission(tx,&id,permission,&now)?;}
        for permission in current.difference(&permissions) {
            tx.execute("UPDATE role_permissions SET revoked_at=?1 WHERE role_id=?2 AND permission_key=?3 AND revoked_at IS NULL",params![now,id,permission])?;
        }
        tx.execute("UPDATE roles SET revision=?1,updated_at=?2 WHERE id=?3",params![revision,now,id])?;
        if had_admin {security::preserve_administrator(tx)?;}
        audit::mutation(tx,&actor,"role",&id,None,"permission_changed",(Some(Snapshot::revision(previous)), Snapshot::revision(revision)))?;
        Ok(Mutation{id,revision})
    }).await
}

pub async fn assignments(db: &Database, actor: Actor, user: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        security::require(tx,&actor,"roles.view",None)?;
        let mut statement=tx.prepare("SELECT ur.id,ur.user_id,ur.role_id,r.display_name,ur.scope_kind AS scope,ur.client_id,ur.assigned_at FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?1 AND ur.revoked_at IS NULL AND (?2 IS NULL OR ur.id>?2) ORDER BY ur.id LIMIT ?3")?;
        let data=statement.query_map(params![user,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    role_id: String,
    scope: String,
    client_id: Option<String>,
    confirm: bool,
}

pub async fn assign(
    db: &Database,
    actor: Actor,
    user: String,
    input: Assignment,
) -> Result<String> {
    if !input.confirm
        || !matches!(input.scope.as_str(), "global" | "client")
        || (input.scope == "client") != input.client_id.is_some()
    {
        return Err(Error::Invalid("invalid_request"));
    }
    validation::id(&input.role_id)?;
    if let Some(client) = &input.client_id {
        validation::id(client)?;
    }
    db.write(move |tx| {
        security::require(tx,&actor,"roles.manage",None)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND status='active')",[&user],|r|r.get(0))?;
        if !active {return Err(Error::Denied);}
        if let Some(client)=&input.client_id {security::client(tx,client,true).map_err(|_|Error::Denied)?;}
        let permissions=role_permissions(tx,&input.role_id,input.client_id.as_deref())?;
        if permissions.is_empty() {return Err(Error::Denied);}
        for permission in permissions {control(tx,&actor,&permission,input.client_id.as_deref())?;}
        let id=validation::new_id();
        tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES (?1,?2,?3,?4,?5,?6)",params![id,user,input.role_id,input.scope,input.client_id,validation::now()]).map_err(|_|Error::Denied)?;
        audit::mutation(tx,&actor,"role_assignment",&id,input.client_id.as_deref(),"created",(None, Snapshot{exists:Some(true),..Snapshot::default()}))?;
        Ok(id)
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirmation {
    pub confirm: bool,
}

pub async fn revoke(
    db: &Database,
    actor: Actor,
    user: String,
    id: String,
    input: Confirmation,
) -> Result<()> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        security::require(tx,&actor,"roles.manage",None)?;
        let (role,client):(String,Option<String>)=tx.query_row("SELECT role_id,client_id FROM user_roles WHERE id=?1 AND user_id=?2 AND revoked_at IS NULL",params![id,user],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error::Denied)?;
        for permission in role_permissions(tx,&role,client.as_deref())? {control(tx,&actor,&permission,client.as_deref())?;}
        let had_admin=has_administrator(tx)?;
        tx.execute("UPDATE user_roles SET revoked_at=?1 WHERE id=?2",params![validation::now(),id])?;
        if had_admin {security::preserve_administrator(tx)?;}
        audit::mutation(tx,&actor,"role_assignment",&id,client.as_deref(),"archived",(Some(Snapshot{exists:Some(true),..Snapshot::default()}), Snapshot{exists:Some(false),..Snapshot::default()}))?;
        Ok(())
    }).await
}

fn permission_set(permissions: Vec<String>) -> Result<BTreeSet<String>> {
    if permissions.is_empty() || permissions.len() > 100 {
        return Err(Error::Invalid("invalid_request"));
    }
    let mut set = BTreeSet::new();
    for permission in permissions {
        if !crate::db::PERMISSIONS.iter().any(|p| p.0 == permission) || !set.insert(permission) {
            return Err(Error::Invalid("invalid_request"));
        }
    }
    Ok(set)
}

fn role_permissions(
    tx: &Transaction<'_>,
    role: &str,
    client: Option<&str>,
) -> Result<BTreeSet<String>> {
    let mut statement=tx.prepare("SELECT rp.permission_key FROM role_permissions rp JOIN permissions p ON p.permission_key=rp.permission_key WHERE rp.role_id=?1 AND rp.revoked_at IS NULL AND (?2 IS NULL OR p.scope_kind='client') ORDER BY rp.permission_key")?;
    Ok(statement
        .query_map(params![role, client], |r| r.get(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?)
}

fn control(
    tx: &Transaction<'_>,
    actor: &Actor,
    permission: &str,
    client: Option<&str>,
) -> Result<()> {
    let allowed=match client {
        Some(client)=>security::allowed_user(tx,&actor.user_id,permission,Some(client))?,
        None=>tx.query_row("SELECT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=?1 AND ur.scope_kind='global' AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key=?2)",params![actor.user_id,permission],|r|r.get(0))?,
    };
    if allowed { Ok(()) } else { Err(Error::Denied) }
}

fn add_permission(tx: &Transaction<'_>, role: &str, permission: &str, now: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) VALUES (?1,?2,?3,?4)",
        params![validation::new_id(), role, permission, now],
    )?;
    Ok(())
}

fn user_snapshot(revision: i64, status: &str) -> Snapshot {
    Snapshot {
        status: Some(status.into()),
        ..Snapshot::revision(revision)
    }
}

fn has_administrator(tx: &Transaction<'_>) -> Result<bool> {
    match security::preserve_administrator(tx) {
        Ok(()) => Ok(true),
        Err(Error::Conflict("last_administrator")) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::Login, testing::Fixture};

    #[tokio::test]
    async fn scoped_grants_never_escalate_and_recovery_authority_survives() {
        let f = Fixture::new().await;
        let user = create_user(
            &f.auth,
            f.actor.clone(),
            NewUser {
                email: "scoped@example.com".into(),
                display_name: "Synthetic scoped identity".into(),
                password: "synthetic-password".into(),
            },
        )
        .await
        .unwrap();
        let role = create_role(
            &f.db,
            f.actor.clone(),
            NewRole {
                display_name: "Synthetic constrained role".into(),
                permissions: vec!["roles.manage".into(), "clients.view".into()],
            },
        )
        .await
        .unwrap();
        assign(
            &f.db,
            f.actor.clone(),
            user.id.clone(),
            Assignment {
                role_id: role.id.clone(),
                scope: "client".into(),
                client_id: Some(f.client.clone()),
                confirm: true,
            },
        )
        .await
        .unwrap();
        let login = f
            .auth
            .login(
                Login {
                    email: "scoped@example.com".into(),
                    password: "synthetic-password".into(),
                },
                audit::request_id(),
            )
            .await
            .unwrap();
        assert!(
            !login
                .session
                .user
                .permissions
                .iter()
                .any(|g| g.permission == "roles.manage")
        );
        assert!(
            crate::clients::read(&f.db, login.session.actor.clone(), f.client.clone())
                .await
                .is_ok()
        );
        assert!(
            create_role(
                &f.db,
                login.session.actor.clone(),
                NewRole {
                    display_name: "Escalation".into(),
                    permissions: vec!["users.manage".into()]
                }
            )
            .await
            .is_err()
        );
        let other = crate::clients::create(
            &f.db,
            f.actor.clone(),
            validation::json(br#"{"name":"Synthetic other client"}"#).unwrap(),
        )
        .await
        .unwrap();
        assert!(
            crate::clients::read(&f.db, login.session.actor, other.id)
                .await
                .is_err()
        );
        let conn = f.connection();
        let admin_assignment:String=conn.query_row("SELECT id FROM user_roles WHERE user_id=?1 AND scope_kind='global' AND revoked_at IS NULL",[&f.actor.user_id],|r|r.get(0)).unwrap();
        assert!(matches!(
            revoke(
                &f.db,
                f.actor.clone(),
                f.actor.user_id.clone(),
                admin_assignment,
                Confirmation { confirm: true }
            )
            .await,
            Err(Error::Conflict("last_administrator"))
        ));
        assert!(matches!(
            disable_user(
                &f.db,
                f.actor.clone(),
                f.actor.user_id.clone(),
                crate::clients::ConfirmRevision {
                    expected_revision: 1,
                    confirm: true
                }
            )
            .await,
            Err(Error::Conflict("self_disable"))
        ));
        assert!(matches!(
            replace_permissions(
                &f.db,
                f.actor.clone(),
                crate::db::ADMIN_ROLE.into(),
                ReplacePermissions {
                    permissions: vec!["clients.view".into()],
                    expected_revision: 1,
                    confirm: true
                }
            )
            .await,
            Err(Error::Conflict("system_role"))
        ));
    }
}
