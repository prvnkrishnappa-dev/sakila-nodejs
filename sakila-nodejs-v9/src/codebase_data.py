"""
Embedded Java source files from: https://github.com/codejsha/spring-rest-sakila
These represent the actual classes from the Spring Boot Sakila (DVD rental) project.
"""

JAVA_FILES = {
    "src/main/java/com/example/sakila/actor/ActorController.java": {
        "category": "Controller",
        "content": """\
package com.example.sakila.actor;

import com.example.sakila.actor.request.ActorRequest;
import com.example.sakila.actor.response.ActorResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.hateoas.CollectionModel;
import org.springframework.hateoas.EntityModel;
import org.springframework.hateoas.IanaLinkRelations;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

import static org.springframework.hateoas.server.mvc.WebMvcLinkBuilder.linkTo;
import static org.springframework.hateoas.server.mvc.WebMvcLinkBuilder.methodOn;

@Tag(name = "Actor", description = "Actor API")
@RestController
@RequestMapping("/api/v1/actors")
@RequiredArgsConstructor
public class ActorController {

    private final ActorService actorService;

    @Operation(summary = "Get all actors")
    @GetMapping
    public ResponseEntity<CollectionModel<EntityModel<ActorResponse>>> getAllActors() {
        List<ActorResponse> actors = actorService.getAllActors();
        List<EntityModel<ActorResponse>> entityModels = actors.stream()
                .map(actor -> EntityModel.of(actor,
                        linkTo(methodOn(ActorController.class).getActorById(actor.getActorId())).withSelfRel()))
                .toList();
        CollectionModel<EntityModel<ActorResponse>> collectionModel = CollectionModel.of(entityModels,
                linkTo(methodOn(ActorController.class).getAllActors()).withSelfRel());
        return ResponseEntity.ok(collectionModel);
    }

    @Operation(summary = "Get actor by ID")
    @GetMapping("/{actorId}")
    public ResponseEntity<EntityModel<ActorResponse>> getActorById(@PathVariable Short actorId) {
        ActorResponse actor = actorService.getActorById(actorId);
        EntityModel<ActorResponse> entityModel = EntityModel.of(actor,
                linkTo(methodOn(ActorController.class).getActorById(actorId)).withSelfRel(),
                linkTo(methodOn(ActorController.class).getAllActors()).withRel("actors"));
        return ResponseEntity.ok(entityModel);
    }

    @Operation(summary = "Create actor")
    @PostMapping
    public ResponseEntity<EntityModel<ActorResponse>> createActor(@RequestBody ActorRequest request) {
        ActorResponse actor = actorService.createActor(request);
        EntityModel<ActorResponse> entityModel = EntityModel.of(actor,
                linkTo(methodOn(ActorController.class).getActorById(actor.getActorId())).withSelfRel());
        return ResponseEntity.created(
                entityModel.getRequiredLink(IanaLinkRelations.SELF).toUri()
        ).body(entityModel);
    }

    @Operation(summary = "Update actor")
    @PutMapping("/{actorId}")
    public ResponseEntity<EntityModel<ActorResponse>> updateActor(
            @PathVariable Short actorId,
            @RequestBody ActorRequest request) {
        ActorResponse actor = actorService.updateActor(actorId, request);
        EntityModel<ActorResponse> entityModel = EntityModel.of(actor,
                linkTo(methodOn(ActorController.class).getActorById(actorId)).withSelfRel());
        return ResponseEntity.ok(entityModel);
    }

    @Operation(summary = "Delete actor")
    @DeleteMapping("/{actorId}")
    public ResponseEntity<Void> deleteActor(@PathVariable Short actorId) {
        actorService.deleteActor(actorId);
        return ResponseEntity.noContent().build();
    }
}
"""
    },

    "src/main/java/com/example/sakila/actor/ActorService.java": {
        "category": "Service",
        "content": """\
package com.example.sakila.actor;

import com.example.sakila.actor.request.ActorRequest;
import com.example.sakila.actor.response.ActorResponse;
import com.example.sakila.exception.DataNotFoundException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ActorService {

    private final ActorRepository actorRepository;

    @Transactional(readOnly = true)
    public List<ActorResponse> getAllActors() {
        return actorRepository.findAll().stream()
                .map(ActorResponse::new)
                .toList();
    }

    @Transactional(readOnly = true)
    public ActorResponse getActorById(Short actorId) {
        Actor actor = actorRepository.findById(actorId)
                .orElseThrow(() -> new DataNotFoundException("Actor not found: " + actorId));
        return new ActorResponse(actor);
    }

    @Transactional
    public ActorResponse createActor(ActorRequest request) {
        Actor actor = Actor.builder()
                .firstName(request.getFirstName())
                .lastName(request.getLastName())
                .build();
        Actor saved = actorRepository.save(actor);
        return new ActorResponse(saved);
    }

    @Transactional
    public ActorResponse updateActor(Short actorId, ActorRequest request) {
        Actor actor = actorRepository.findById(actorId)
                .orElseThrow(() -> new DataNotFoundException("Actor not found: " + actorId));
        actor.update(request.getFirstName(), request.getLastName());
        return new ActorResponse(actor);
    }

    @Transactional
    public void deleteActor(Short actorId) {
        Actor actor = actorRepository.findById(actorId)
                .orElseThrow(() -> new DataNotFoundException("Actor not found: " + actorId));
        actorRepository.delete(actor);
    }
}
"""
    },

    "src/main/java/com/example/sakila/actor/ActorRepository.java": {
        "category": "Repository",
        "content": """\
package com.example.sakila.actor;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ActorRepository extends JpaRepository<Actor, Short> {

    @Query("SELECT a FROM Actor a WHERE UPPER(a.firstName) LIKE UPPER(CONCAT(:firstName, '%'))")
    List<Actor> findByFirstNameStartingWithIgnoreCase(@Param("firstName") String firstName);

    @Query("SELECT a FROM Actor a WHERE UPPER(a.lastName) LIKE UPPER(CONCAT(:lastName, '%'))")
    List<Actor> findByLastNameStartingWithIgnoreCase(@Param("lastName") String lastName);

    @Query("SELECT DISTINCT a FROM Actor a JOIN a.filmActors fa JOIN fa.film f WHERE f.title = :title")
    List<Actor> findActorsByFilmTitle(@Param("title") String title);

    Optional<Actor> findByFirstNameAndLastName(String firstName, String lastName);
}
"""
    },

    "src/main/java/com/example/sakila/actor/Actor.java": {
        "category": "Entity",
        "content": """\
package com.example.sakila.actor;

import com.example.sakila.film.FilmActor;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "actor")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@AllArgsConstructor
@Builder
public class Actor {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "actor_id")
    private Short actorId;

    @Column(name = "first_name", nullable = false, length = 45)
    private String firstName;

    @Column(name = "last_name", nullable = false, length = 45)
    private String lastName;

    @UpdateTimestamp
    @Column(name = "last_update", nullable = false)
    private LocalDateTime lastUpdate;

    @OneToMany(mappedBy = "actor", cascade = CascadeType.ALL, orphanRemoval = true)
    @Builder.Default
    private List<FilmActor> filmActors = new ArrayList<>();

    public void update(String firstName, String lastName) {
        this.firstName = firstName;
        this.lastName = lastName;
    }
}
"""
    },

    "src/main/java/com/example/sakila/film/FilmController.java": {
        "category": "Controller",
        "content": """\
package com.example.sakila.film;

import com.example.sakila.film.request.FilmRequest;
import com.example.sakila.film.response.FilmResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.hateoas.CollectionModel;
import org.springframework.hateoas.EntityModel;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Film", description = "Film API")
@RestController
@RequestMapping("/api/v1/films")
@RequiredArgsConstructor
public class FilmController {

    private final FilmService filmService;

    @Operation(summary = "Get all films")
    @GetMapping
    public ResponseEntity<List<FilmResponse>> getAllFilms(
            @RequestParam(required = false) String title,
            @RequestParam(required = false) Short categoryId) {
        List<FilmResponse> films;
        if (title != null) {
            films = filmService.searchByTitle(title);
        } else if (categoryId != null) {
            films = filmService.getFilmsByCategory(categoryId);
        } else {
            films = filmService.getAllFilms();
        }
        return ResponseEntity.ok(films);
    }

    @Operation(summary = "Get film by ID")
    @GetMapping("/{filmId}")
    public ResponseEntity<FilmResponse> getFilmById(@PathVariable Integer filmId) {
        return ResponseEntity.ok(filmService.getFilmById(filmId));
    }

    @Operation(summary = "Create film")
    @PostMapping
    public ResponseEntity<FilmResponse> createFilm(@RequestBody FilmRequest request) {
        FilmResponse film = filmService.createFilm(request);
        return ResponseEntity.status(201).body(film);
    }

    @Operation(summary = "Update film")
    @PutMapping("/{filmId}")
    public ResponseEntity<FilmResponse> updateFilm(
            @PathVariable Integer filmId,
            @RequestBody FilmRequest request) {
        return ResponseEntity.ok(filmService.updateFilm(filmId, request));
    }

    @Operation(summary = "Delete film")
    @DeleteMapping("/{filmId}")
    public ResponseEntity<Void> deleteFilm(@PathVariable Integer filmId) {
        filmService.deleteFilm(filmId);
        return ResponseEntity.noContent().build();
    }
}
"""
    },

    "src/main/java/com/example/sakila/film/FilmService.java": {
        "category": "Service",
        "content": """\
package com.example.sakila.film;

import com.example.sakila.exception.DataNotFoundException;
import com.example.sakila.film.request.FilmRequest;
import com.example.sakila.film.response.FilmResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class FilmService {

    private final FilmRepository filmRepository;

    @Transactional(readOnly = true)
    public List<FilmResponse> getAllFilms() {
        return filmRepository.findAll().stream()
                .map(FilmResponse::new)
                .toList();
    }

    @Transactional(readOnly = true)
    public FilmResponse getFilmById(Integer filmId) {
        Film film = filmRepository.findById(filmId)
                .orElseThrow(() -> new DataNotFoundException("Film not found: " + filmId));
        return new FilmResponse(film);
    }

    @Transactional(readOnly = true)
    public List<FilmResponse> searchByTitle(String title) {
        return filmRepository.findByTitleContainingIgnoreCase(title).stream()
                .map(FilmResponse::new)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<FilmResponse> getFilmsByCategory(Short categoryId) {
        return filmRepository.findByCategoryId(categoryId).stream()
                .map(FilmResponse::new)
                .toList();
    }

    @Transactional
    public FilmResponse createFilm(FilmRequest request) {
        Film film = Film.builder()
                .title(request.getTitle())
                .description(request.getDescription())
                .releaseYear(request.getReleaseYear())
                .languageId(request.getLanguageId())
                .rentalDuration(request.getRentalDuration())
                .rentalRate(request.getRentalRate())
                .length(request.getLength())
                .replacementCost(request.getReplacementCost())
                .rating(request.getRating())
                .build();
        return new FilmResponse(filmRepository.save(film));
    }

    @Transactional
    public FilmResponse updateFilm(Integer filmId, FilmRequest request) {
        Film film = filmRepository.findById(filmId)
                .orElseThrow(() -> new DataNotFoundException("Film not found: " + filmId));
        film.update(request.getTitle(), request.getDescription(), request.getReleaseYear(),
                request.getRentalDuration(), request.getRentalRate(), request.getLength(),
                request.getReplacementCost(), request.getRating());
        return new FilmResponse(film);
    }

    @Transactional
    public void deleteFilm(Integer filmId) {
        Film film = filmRepository.findById(filmId)
                .orElseThrow(() -> new DataNotFoundException("Film not found: " + filmId));
        filmRepository.delete(film);
    }
}
"""
    },

    "src/main/java/com/example/sakila/film/FilmRepository.java": {
        "category": "Repository",
        "content": """\
package com.example.sakila.film;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface FilmRepository extends JpaRepository<Film, Integer> {

    List<Film> findByTitleContainingIgnoreCase(String title);

    @Query("SELECT f FROM Film f JOIN f.filmCategories fc WHERE fc.category.categoryId = :categoryId")
    List<Film> findByCategoryId(@Param("categoryId") Short categoryId);

    @Query("SELECT f FROM Film f JOIN f.filmActors fa WHERE fa.actor.actorId = :actorId")
    List<Film> findByActorId(@Param("actorId") Short actorId);

    @Query("SELECT f FROM Film f WHERE f.rentalRate <= :maxRate ORDER BY f.rentalRate")
    List<Film> findByRentalRateLessThanEqualOrderByRentalRate(@Param("maxRate") java.math.BigDecimal maxRate);
}
"""
    },

    "src/main/java/com/example/sakila/customer/CustomerController.java": {
        "category": "Controller",
        "content": """\
package com.example.sakila.customer;

import com.example.sakila.customer.request.CustomerRequest;
import com.example.sakila.customer.response.CustomerResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Customer", description = "Customer API")
@RestController
@RequestMapping("/api/v1/customers")
@RequiredArgsConstructor
public class CustomerController {

    private final CustomerService customerService;

    @Operation(summary = "Get all customers")
    @GetMapping
    public ResponseEntity<List<CustomerResponse>> getAllCustomers() {
        return ResponseEntity.ok(customerService.getAllCustomers());
    }

    @Operation(summary = "Get customer by ID")
    @GetMapping("/{customerId}")
    public ResponseEntity<CustomerResponse> getCustomerById(@PathVariable Integer customerId) {
        return ResponseEntity.ok(customerService.getCustomerById(customerId));
    }

    @Operation(summary = "Create customer")
    @PostMapping
    public ResponseEntity<CustomerResponse> createCustomer(@RequestBody CustomerRequest request) {
        CustomerResponse customer = customerService.createCustomer(request);
        return ResponseEntity.status(201).body(customer);
    }

    @Operation(summary = "Update customer")
    @PutMapping("/{customerId}")
    public ResponseEntity<CustomerResponse> updateCustomer(
            @PathVariable Integer customerId,
            @RequestBody CustomerRequest request) {
        return ResponseEntity.ok(customerService.updateCustomer(customerId, request));
    }

    @Operation(summary = "Delete customer")
    @DeleteMapping("/{customerId}")
    public ResponseEntity<Void> deleteCustomer(@PathVariable Integer customerId) {
        customerService.deleteCustomer(customerId);
        return ResponseEntity.noContent().build();
    }
}
"""
    },

    "src/main/java/com/example/sakila/rental/RentalController.java": {
        "category": "Controller",
        "content": """\
package com.example.sakila.rental;

import com.example.sakila.rental.request.RentalRequest;
import com.example.sakila.rental.response.RentalResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Rental", description = "Rental API")
@RestController
@RequestMapping("/api/v1/rentals")
@RequiredArgsConstructor
public class RentalController {

    private final RentalService rentalService;

    @Operation(summary = "Get all rentals")
    @GetMapping
    public ResponseEntity<List<RentalResponse>> getAllRentals() {
        return ResponseEntity.ok(rentalService.getAllRentals());
    }

    @Operation(summary = "Get rental by ID")
    @GetMapping("/{rentalId}")
    public ResponseEntity<RentalResponse> getRentalById(@PathVariable Integer rentalId) {
        return ResponseEntity.ok(rentalService.getRentalById(rentalId));
    }

    @Operation(summary = "Get rentals by customer")
    @GetMapping("/customer/{customerId}")
    public ResponseEntity<List<RentalResponse>> getRentalsByCustomer(@PathVariable Integer customerId) {
        return ResponseEntity.ok(rentalService.getRentalsByCustomer(customerId));
    }

    @Operation(summary = "Create rental (checkout)")
    @PostMapping
    public ResponseEntity<RentalResponse> createRental(@RequestBody RentalRequest request) {
        return ResponseEntity.status(201).body(rentalService.createRental(request));
    }

    @Operation(summary = "Return rental")
    @PatchMapping("/{rentalId}/return")
    public ResponseEntity<RentalResponse> returnRental(@PathVariable Integer rentalId) {
        return ResponseEntity.ok(rentalService.returnRental(rentalId));
    }
}
"""
    },

    "src/main/java/com/example/sakila/exception/DataNotFoundException.java": {
        "category": "Other Java",
        "content": """\
package com.example.sakila.exception;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.NOT_FOUND)
public class DataNotFoundException extends RuntimeException {
    public DataNotFoundException(String message) {
        super(message);
    }
}
"""
    },

    "src/main/java/com/example/sakila/config/SwaggerConfig.java": {
        "category": "Config",
        "content": """\
package com.example.sakila.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class SwaggerConfig {

    @Bean
    public OpenAPI openAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("Sakila REST API")
                        .description("Spring Boot REST API for Sakila DVD rental database")
                        .version("v1"));
    }
}
"""
    },
}
